const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { SageMakerClient, CreateTrainingJobCommand, DescribeTrainingJobCommand, CreateModelCommand, CreateEndpointConfigCommand, CreateEndpointCommand, DeleteEndpointCommand, DeleteModelCommand, DeleteEndpointConfigCommand, DescribeEndpointCommand } = require('@aws-sdk/client-sagemaker');
const db = require('./db-connection');
const awsConfig = require('./aws-config');
const { authenticateToken } = require('./auth-middleware');

const router = express.Router();
const s3Client = new S3Client({ 
    region: awsConfig.region,
    credentials: {
        accessKeyId: awsConfig.accessKeyId,
        secretAccessKey: awsConfig.secretAccessKey
    },
    forcePathStyle: awsConfig.s3ForcePathStyle,
    signatureVersion: awsConfig.signatureVersion
});
const sagemakerClient = new SageMakerClient({ 
    region: awsConfig.region,
    credentials: {
        accessKeyId: awsConfig.accessKeyId,
        secretAccessKey: awsConfig.secretAccessKey
    }
});

// Multer 配置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'temp-uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
        fileSize: 1024 * 1024 * 1024 // 1GB
    }
});

// 上传文件到 S3
async function uploadToS3(filePath, key) {
    const fileContent = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
        Bucket: awsConfig.s3Bucket,
        Key: key,
    Body: fileContent
    });
    await s3Client.send(command);
}

// 上传数据集
router.post('/upload-dataset', authenticateToken, upload.single('zipFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传数据集文件' });
        }

    const { name, description } = req.body;
        if (!name) {
            return res.status(400).json({ error: '数据集名称不能为空' });
        }

    const datasetId = uuidv4();
        const s3Key = `${awsConfig.datasetsPrefix}${datasetId}.zip`;

        // 上传到 S3
        await uploadToS3(req.file.path, s3Key);
    
        // 保存到数据库
        const [result] = await db.query(
      'INSERT INTO training_datasets (id, user_id, name, description, s3_prefix, status) VALUES (?, ?, ?, ?, ?, ?)',
            [datasetId, req.user.id, name, description, s3Key, 'ready']
        );

        // 删除临时文件
        fs.unlinkSync(req.file.path);
    
    res.json({ 
            message: '数据集上传成功',
            datasetId: datasetId
    });
  } catch (error) {
        console.error('上传数据集失败:', error);
    res.status(500).json({ error: '上传数据集失败' });
  }
});

// 获取数据集列表
router.get('/datasets', authenticateToken, async (req, res) => {
  try {
        const [datasets] = await db.query(
            'SELECT * FROM training_datasets WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
    res.json(datasets);
  } catch (error) {
        console.error('获取数据集列表失败:', error);
    res.status(500).json({ error: '获取数据集列表失败' });
  }
});

// 删除数据集
router.delete('/datasets/:datasetId', authenticateToken, async (req, res) => {
    try {
        const { datasetId } = req.params;
        console.log(`尝试删除数据集 ID: ${datasetId}, 用户 ID: ${req.user.id}`);

        // 检查数据集是否正在使用
        const [models] = await db.query(
            'SELECT COUNT(*) as count FROM clip_models WHERE dataset_id = ?',
            [datasetId]
        );
        console.log(`检查数据集使用情况: ${JSON.stringify(models[0])}`);

        if (models[0].count > 0) {
            console.log(`数据集 ${datasetId} 正在被使用，无法删除`);
            return res.status(400).json({ error: '该数据集正在被使用，无法删除' });
        }

        // 获取 S3 路径
        console.log(`正在查询数据集 S3 路径...`);
        const [datasets] = await db.query(
            'SELECT * FROM training_datasets WHERE id = ? AND user_id = ?',
            [datasetId, req.user.id]
        );
        console.log(`数据集查询结果: ${JSON.stringify(datasets)}`);

        if (datasets.length === 0) {
            console.log(`未找到数据集 ${datasetId}`);
            return res.status(404).json({ error: '数据集不存在' });
        }

        // 从 S3 删除文件
        try {
            if (datasets[0].s3_prefix) {
                console.log(`准备从 S3 删除文件: ${datasets[0].s3_prefix}`);
                const command = new DeleteObjectCommand({
                    Bucket: awsConfig.s3Bucket,
                    Key: datasets[0].s3_prefix
                });
                await s3Client.send(command);
                console.log(`S3文件删除成功: ${datasets[0].s3_prefix}`);
            } else {
                console.log(`数据集 ${datasetId} 没有 S3 路径`);
            }
        } catch (s3Error) {
            console.error('从S3删除文件失败:', s3Error);
            // 继续执行，仍然删除数据库记录
        }

        // 从数据库删除记录
        console.log(`正在从数据库删除数据集记录...`);
        const [deleteResult] = await db.query(
            'DELETE FROM training_datasets WHERE id = ? AND user_id = ?',
            [datasetId, req.user.id]
        );
        console.log(`数据库删除结果: ${JSON.stringify(deleteResult)}`);

        res.json({ message: '数据集删除成功' });
  } catch (error) {
        console.error('删除数据集失败:', error);
        res.status(500).json({ error: '删除数据集失败: ' + error.message });
  }
});

// 开始训练
router.post('/start', authenticateToken, async (req, res) => {
  try {
        const { datasetId, modelName, description, epochs, batchSize, learningRate } = req.body;
    
        // 验证输入
    if (!datasetId) {
            return res.status(400).json({ error: '数据集ID不能为空' });
        }

        // 检查数据集状态
        const [datasets] = await db.query(
            'SELECT * FROM training_datasets WHERE id = ? AND user_id = ?',
            [datasetId, req.user.id]
    );
    
    if (datasets.length === 0) {
            return res.status(404).json({ error: '数据集不存在' });
        }

        if (datasets[0].status !== 'ready') {
            return res.status(400).json({ error: '数据集状态不正确' });
        }

        // 创建模型记录
    const modelId = uuidv4();
        const modelS3Path = `${awsConfig.modelsPrefix}${modelId}/`;
        
        await db.query(
            'INSERT INTO clip_models (id, user_id, dataset_id, name, s3_path, status) VALUES (?, ?, ?, ?, ?, ?)',
            [modelId, req.user.id, datasetId, modelName || `模型-${new Date().toISOString().split('T')[0]}`, 
             modelS3Path, 'training']
        );

        // 准备训练脚本
        const trainingScriptPath = path.join(__dirname, 'train.py');
        if (!fs.existsSync(trainingScriptPath)) {
            // 如果train.py不存在，使用附带的train.py文件
            fs.copyFileSync(path.join(__dirname, 'training-scripts', 'train.py'), trainingScriptPath);
        }
        
        const trainingScriptKey = `training-scripts/${modelId}.py`;
        await uploadToS3(trainingScriptPath, trainingScriptKey);

        // 创建训练作业
        const trainingJobName = `clip-training-${modelId.replace(/-/g, '').substring(0, 30)}`;
        const command = new CreateTrainingJobCommand({
            TrainingJobName: trainingJobName,
            AlgorithmSpecification: {
                TrainingImage: awsConfig.trainingImage,
                TrainingInputMode: 'File',
                EnableSageMakerMetricsTimeSeries: true
            },
            InputDataConfig: [{
                ChannelName: 'training',
                DataSource: {
                    S3DataSource: {
                        S3DataType: 'S3Prefix',
                        S3Uri: `s3://${awsConfig.s3Bucket}/${datasets[0].s3_prefix}`,
                        S3DataDistributionType: 'FullyReplicated'
                    }
                },
                ContentType: 'application/zip'
            }],
            OutputDataConfig: {
                S3OutputPath: `s3://${awsConfig.s3Bucket}/${modelS3Path}`
            },
            ResourceConfig: {
                InstanceType: awsConfig.trainingInstanceType,
                InstanceCount: 1,
                VolumeSizeInGB: 30
            },
            StoppingCondition: {
                MaxRuntimeInSeconds: 7200 // 2小时
            },
            HyperParameters: {
                epochs: String(epochs || '2'), // 减少轮次以加快训练
                batch_size: String(batchSize || '16'), // 减小批量大小以适应CPU内存
                learning_rate: String(learningRate || '1e-4')
            },
            RoleArn: awsConfig.sagemakerRole
        });

        await sagemakerClient.send(command);

        // 启动状态检查
        checkTrainingStatus(trainingJobName, modelId);
    
    res.json({
            message: '训练任务已启动',
            modelId: modelId
    });
  } catch (error) {
        console.error('启动训练失败:', error);
        res.status(500).json({ error: '启动训练失败: ' + error.message });
    }
});

// 检查训练状态
async function checkTrainingStatus(trainingJobName, modelId) {
    try {
        const command = new DescribeTrainingJobCommand({
            TrainingJobName: trainingJobName
        });

        const response = await sagemakerClient.send(command);
        const status = response.TrainingJobStatus;

        // 更新数据库状态
        await db.query(
            'UPDATE clip_models SET status = ? WHERE id = ?',
            [status.toLowerCase(), modelId]
        );

        if (status === 'Completed') {
            // 训练完成，更新模型路径
            const modelPath = response.ModelArtifacts.S3ModelArtifacts;
            await db.query(
                'UPDATE clip_models SET s3_path = ?, status = "ready" WHERE id = ?',
                [modelPath, modelId]
            );
            console.log(`模型 ${modelId} 训练完成`);
        } else if (status === 'Failed') {
            // 训练失败，记录错误信息
            await db.query(
                'UPDATE clip_models SET status = "error" WHERE id = ?',
                [modelId]
            );
            console.log(`模型 ${modelId} 训练失败: ${response.FailureReason}`);
        } else if (status === 'InProgress') {
            // 继续检查状态
            console.log(`模型 ${modelId} 训练中...`);
            setTimeout(() => checkTrainingStatus(trainingJobName, modelId), 30000);
        }
    } catch (error) {
        console.error('检查训练状态失败:', error);
        await db.query(
            'UPDATE clip_models SET status = "error" WHERE id = ?',
            [modelId]
        );
    }
}

// 获取模型列表
router.get('/models', authenticateToken, async (req, res) => {
  try {
        const [models] = await db.query(
            `SELECT m.*, d.name as dataset_name 
       FROM clip_models m
             JOIN training_datasets d ON m.dataset_id = d.id 
             WHERE m.user_id = ? 
       ORDER BY m.created_at DESC`,
            [req.user.id]
    );
    
    // 格式化响应
    const formattedModels = models.map(model => ({
      id: model.id,
      name: model.name,
      basedOn: model.dataset_name,
      datasetId: model.dataset_id,
            status: model.status,
      endpointName: model.endpoint_name,
      endpointStatus: model.endpoint_status,
      createdAt: model.created_at
    }));
    
    res.json(formattedModels);
  } catch (error) {
        console.error('获取模型列表失败:', error);
    res.status(500).json({ error: '获取模型列表失败' });
  }
});

// 部署模型
router.post('/deploy', authenticateToken, async (req, res) => {
  try {
    const { modelId } = req.body;
    
    if (!modelId) {
            return res.status(400).json({ error: '模型ID不能为空' });
        }

        // 检查模型状态
        const [models] = await db.query(
            'SELECT * FROM clip_models WHERE id = ? AND user_id = ?',
            [modelId, req.user.id]
    );
    
    if (models.length === 0) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (models[0].status !== 'ready') {
            return res.status(400).json({ error: '模型尚未训练完成' });
        }
        
        // 更新模型状态
        await db.query(
            'UPDATE clip_models SET status = "deploying" WHERE id = ?',
            [modelId]
        );

        // 创建 SageMaker 模型
        const modelName = `clip-model-${modelId.replace(/-/g, '').substring(0, 30)}`;
        const createModelCommand = new CreateModelCommand({
            ModelName: modelName,
            PrimaryContainer: {
                Image: awsConfig.inferenceImage,
                ModelDataUrl: models[0].s3_path || `s3://${awsConfig.s3Bucket}/${awsConfig.modelsPrefix}/${modelId}/model.tar.gz`,
                Environment: {
                    SAGEMAKER_PROGRAM: 'inference.py',
                    SAGEMAKER_SUBMIT_DIRECTORY: '/opt/ml/model',
                    SAGEMAKER_CONTAINER_LOG_LEVEL: '20'
                }
            },
            ExecutionRoleArn: awsConfig.sagemakerRole
        });
        await sagemakerClient.send(createModelCommand);

        // 创建端点配置
        const endpointConfigName = `clip-endpoint-config-${modelId.replace(/-/g, '').substring(0, 30)}`;
        const createEndpointConfigCommand = new CreateEndpointConfigCommand({
            EndpointConfigName: endpointConfigName,
            ProductionVariants: [{
                VariantName: 'default',
                ModelName: modelName,
                InstanceType: awsConfig.inferenceInstanceType,
                InitialInstanceCount: 1
            }]
        });
        await sagemakerClient.send(createEndpointConfigCommand);

        // 创建端点
        const endpointName = `clip-endpoint-${modelId.replace(/-/g, '').substring(0, 30)}`;
        const createEndpointCommand = new CreateEndpointCommand({
            EndpointName: endpointName,
            EndpointConfigName: endpointConfigName
        });
        await sagemakerClient.send(createEndpointCommand);

        // 更新数据库
        await db.query(
            'UPDATE clip_models SET endpoint_name = ?, endpoint_status = "Creating" WHERE id = ?',
            [endpointName, modelId]
        );

        // 启动状态检查
        checkDeploymentStatus(endpointName, modelId);
    
    res.json({
            message: '模型部署已启动',
            endpointName: endpointName
    });
  } catch (error) {
        console.error('部署模型失败:', error);
        await db.query(
            'UPDATE clip_models SET status = "error" WHERE id = ?',
            [modelId]
        );
        res.status(500).json({ error: '部署模型失败: ' + error.message });
    }
});

// 检查部署状态
async function checkDeploymentStatus(endpointName, modelId) {
    try {
        const command = new DescribeEndpointCommand({
            EndpointName: endpointName
        });

        const response = await sagemakerClient.send(command);
        const status = response.EndpointStatus;

        // 更新数据库状态
        await db.query(
            'UPDATE clip_models SET endpoint_status = ? WHERE id = ?',
            [status, modelId]
        );

        if (status === 'InService') {
            // 部署完成
            await db.query(
                'UPDATE clip_models SET status = "deployed" WHERE id = ?',
                [modelId]
            );
            console.log(`模型 ${modelId} 部署完成`);
        } else if (status === 'Failed') {
            // 部署失败
            await db.query(
                'UPDATE clip_models SET status = "error" WHERE id = ?',
                [modelId]
            );
            console.log(`模型 ${modelId} 部署失败: ${response.FailureReason}`);
        } else if (status === 'Creating') {
            // 继续检查状态
            console.log(`模型 ${modelId} 部署中...`);
            setTimeout(() => checkDeploymentStatus(endpointName, modelId), 30000);
        }
    } catch (error) {
        console.error('检查部署状态失败:', error);
        await db.query(
            'UPDATE clip_models SET status = "error" WHERE id = ?',
            [modelId]
        );
    }
}

// 取消部署
router.post('/undeploy', authenticateToken, async (req, res) => {
  try {
    const { modelId } = req.body;
    
    if (!modelId) {
            return res.status(400).json({ error: '模型ID不能为空' });
        }

        // 获取模型信息
        const [models] = await db.query(
            'SELECT * FROM clip_models WHERE id = ? AND user_id = ?',
            [modelId, req.user.id]
    );
    
    if (models.length === 0) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (!models[0].endpoint_name) {
            return res.status(400).json({ error: '模型尚未部署' });
        }

        // 删除端点
        const deleteEndpointCommand = new DeleteEndpointCommand({
            EndpointName: models[0].endpoint_name
        });
        await sagemakerClient.send(deleteEndpointCommand);

        // 删除端点配置
        const endpointConfigName = `clip-endpoint-config-${modelId.replace(/-/g, '').substring(0, 30)}`;
        const deleteEndpointConfigCommand = new DeleteEndpointConfigCommand({
            EndpointConfigName: endpointConfigName
        });
        await sagemakerClient.send(deleteEndpointConfigCommand);

        // 删除模型
        const modelName = `clip-model-${modelId.replace(/-/g, '').substring(0, 30)}`;
        const deleteModelCommand = new DeleteModelCommand({
            ModelName: modelName
        });
        await sagemakerClient.send(deleteModelCommand);

        // 更新数据库
        await db.query(
            'UPDATE clip_models SET status = "ready", endpoint_name = NULL, endpoint_status = NULL WHERE id = ?',
      [modelId]
    );
    
        res.json({ message: '模型已取消部署' });
  } catch (error) {
        console.error('取消部署模型失败:', error);
        res.status(500).json({ error: '取消部署模型失败: ' + error.message });
  }
});

// 删除模型
router.delete('/models/:modelId', authenticateToken, async (req, res) => {
    try {
        const { modelId } = req.params;

        // 检查模型状态
        const [models] = await db.query(
            'SELECT * FROM clip_models WHERE id = ? AND user_id = ?',
            [modelId, req.user.id]
    );
    
    if (models.length === 0) {
            return res.status(404).json({ error: '模型不存在' });
        }

        if (models[0].status === 'deployed') {
            return res.status(400).json({ error: '请先取消部署模型' });
        }

        // 如果模型已部署，先取消部署
        if (models[0].endpoint_name) {
            try {
                // 删除端点
                const deleteEndpointCommand = new DeleteEndpointCommand({
                    EndpointName: models[0].endpoint_name
                });
                await sagemakerClient.send(deleteEndpointCommand);

                // 删除端点配置
                const endpointConfigName = `clip-endpoint-config-${modelId.replace(/-/g, '').substring(0, 30)}`;
                const deleteEndpointConfigCommand = new DeleteEndpointConfigCommand({
                    EndpointConfigName: endpointConfigName
                });
                await sagemakerClient.send(deleteEndpointConfigCommand);

                // 删除模型
                const modelName = `clip-model-${modelId.replace(/-/g, '').substring(0, 30)}`;
                const deleteModelCommand = new DeleteModelCommand({
                    ModelName: modelName
                });
                await sagemakerClient.send(deleteModelCommand);
            } catch (deleteError) {
                console.error('删除SageMaker资源时出错:', deleteError);
                // 继续执行，删除数据库记录
            }
        }

        // 从 S3 删除模型文件
        try {
            if (models[0].s3_path) {
                const deleteCommand = new DeleteObjectCommand({
                    Bucket: awsConfig.s3Bucket,
                    Key: models[0].s3_path
                });
                await s3Client.send(deleteCommand);
            }
        } catch (s3Error) {
            console.error('删除S3文件时出错:', s3Error);
            // 继续执行，删除数据库记录
        }

        // 从数据库删除记录
        await db.query(
            'DELETE FROM clip_models WHERE id = ?',
            [modelId]
        );

        res.json({ message: '模型删除成功' });
    } catch (error) {
        console.error('删除模型失败:', error);
        res.status(500).json({ error: '删除模型失败: ' + error.message });
    }
});

// 强制删除模型（包括训练中的模型）
router.delete('/models/:modelId/force', authenticateToken, async (req, res) => {
    try {
        const { modelId } = req.params;
        console.log(`尝试强制删除模型 ID: ${modelId}, 用户 ID: ${req.user.id}`);

        // 检查模型是否存在
        const [models] = await db.query(
            'SELECT * FROM clip_models WHERE id = ? AND user_id = ?',
            [modelId, req.user.id]
        );
        console.log(`查询模型结果: ${JSON.stringify(models)}`);

        if (models.length === 0) {
            return res.status(404).json({ error: '模型不存在' });
        }

        // 如果模型已部署，尝试取消部署
        if (models[0].endpoint_name) {
            try {
                console.log(`尝试删除端点: ${models[0].endpoint_name}`);
                // 删除端点
                const deleteEndpointCommand = new DeleteEndpointCommand({
                    EndpointName: models[0].endpoint_name
                });
                await sagemakerClient.send(deleteEndpointCommand);

                // 删除端点配置
                const endpointConfigName = `clip-endpoint-config-${modelId.replace(/-/g, '').substring(0, 30)}`;
                console.log(`尝试删除端点配置: ${endpointConfigName}`);
                const deleteEndpointConfigCommand = new DeleteEndpointConfigCommand({
                    EndpointConfigName: endpointConfigName
                });
                await sagemakerClient.send(deleteEndpointConfigCommand);

                // 删除模型
                const modelName = `clip-model-${modelId.replace(/-/g, '').substring(0, 30)}`;
                console.log(`尝试删除SageMaker模型: ${modelName}`);
                const deleteModelCommand = new DeleteModelCommand({
                    ModelName: modelName
                });
                await sagemakerClient.send(deleteModelCommand);
            } catch (deleteError) {
                console.error('删除SageMaker资源时出错:', deleteError);
                // 继续执行，删除数据库记录
            }
        }

        // 如果模型正在训练，尝试停止训练作业
        if (models[0].status === 'training') {
            try {
                // 构建训练作业名称（与启动训练时相同）
                const trainingJobName = `clip-training-${modelId.replace(/-/g, '').substring(0, 30)}`;
                console.log(`尝试停止训练作业: ${trainingJobName}`);
                
                // 尝试停止训练作业，但即使失败也继续删除数据库记录
                try {
                    const StopTrainingJobCommand = require('@aws-sdk/client-sagemaker').StopTrainingJobCommand;
                    const stopCommand = new StopTrainingJobCommand({
                        TrainingJobName: trainingJobName
                    });
                    await sagemakerClient.send(stopCommand);
                    console.log(`成功发送停止训练作业命令: ${trainingJobName}`);
                } catch (stopError) {
                    console.error(`停止训练作业错误 (这可能是因为作业已经完成或不存在):`, stopError);
                }
            } catch (error) {
                console.error('停止训练作业时出错:', error);
                // 继续执行，删除数据库记录
            }
        }

        // 从 S3 删除模型文件
        try {
            if (models[0].s3_path) {
                console.log(`尝试从S3删除模型文件: ${models[0].s3_path}`);
                const deleteCommand = new DeleteObjectCommand({
                    Bucket: awsConfig.s3Bucket,
                    Key: models[0].s3_path
                });
                await s3Client.send(deleteCommand);
            }
        } catch (s3Error) {
            console.error('删除S3文件时出错:', s3Error);
            // 继续执行，删除数据库记录
        }

        // 从数据库删除记录
        console.log(`从数据库删除模型记录...`);
        await db.query(
            'DELETE FROM clip_models WHERE id = ?',
            [modelId]
        );

        res.json({ message: '模型已强制删除成功' });
  } catch (error) {
        console.error('强制删除模型失败:', error);
        res.status(500).json({ error: '强制删除模型失败: ' + error.message });
  }
});

module.exports = router;