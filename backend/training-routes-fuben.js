// 模型训练相关的API路由
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { s3, s3Config, sageMaker, sageMakerConfig } = require('./aws-config');
const awsConfig = require('./aws-config');

const router = express.Router();

// 配置临时文件存储
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
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 限制50MB
  }
});

// 数据库连接（使用已有的连接）
const pool = require('./db-connection'); // 假设你有一个数据库连接模块

// 上传数据集到S3
const uploadToS3 = async (localFile, s3Key) => {
  const fileContent = fs.readFileSync(localFile);
  
  const params = {
    Bucket: s3Config.bucketName,
    Key: s3Key,
    Body: fileContent
  };
  
  return s3.upload(params).promise();
};

// 创建数据集上传API
router.post('/upload-dataset', authenticateToken, upload.single('zipFile'), async (req, res) => {
  try {
    const { name, description } = req.body;
    const userId = req.user.id;
    
    if (!name || !req.file) {
      return res.status(400).json({ error: '请提供数据集名称和压缩包文件' });
    }
    
    // 创建唯一的数据集ID
    const datasetId = uuidv4();
    const s3Prefix = `${s3Config.trainingPrefix}${userId}/${datasetId}/`;
    
    // 创建数据集记录
    const [result] = await pool.query(
      'INSERT INTO training_datasets (id, user_id, name, description, s3_prefix, status) VALUES (?, ?, ?, ?, ?, ?)',
      [datasetId, userId, name, description, s3Prefix, 'uploading']
    );
    
    // 上传ZIP文件到S3
    const s3Key = `${s3Prefix}dataset.zip`;
    await uploadToS3(req.file.path, s3Key);
    
    // 清理临时文件
    fs.unlinkSync(req.file.path);
    
    // 更新数据集状态为就绪
    await pool.query(
      'UPDATE training_datasets SET status = ? WHERE id = ?',
      ['ready', datasetId]
    );
    
    res.json({ 
      id: datasetId,
      message: '数据集已成功上传'
    });
    
  } catch (error) {
    console.error('上传数据集错误:', error);
    res.status(500).json({ error: '上传数据集失败' });
  }
});

// 获取用户的数据集列表
router.get('/datasets', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [datasets] = await pool.query(
      `SELECT id, name, description, image_count, status, created_at, updated_at, s3_prefix
       FROM training_datasets
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );
    
    res.json(datasets);
    
  } catch (error) {
    console.error('获取数据集列表错误:', error);
    res.status(500).json({ error: '获取数据集列表失败' });
  }
});

// 删除数据集
router.delete('/datasets/:id', authenticateToken, async (req, res) => {
  try {
    const datasetId = req.params.id;
    const userId = req.user.id;
    
    // 验证数据集所属
    const [datasets] = await pool.query(
      'SELECT s3_prefix, status FROM training_datasets WHERE id = ? AND user_id = ?',
      [datasetId, userId]
    );
    
    if (datasets.length === 0) {
      return res.status(404).json({ error: '数据集不存在或无权访问' });
    }
    
    const dataset = datasets[0];
    
    // 不允许删除正在训练中的数据集
    if (dataset.status === 'training') {
      return res.status(400).json({ error: '无法删除正在训练中的数据集' });
    }
    
    // 列出并删除S3中的所有相关对象
    const listParams = {
      Bucket: s3Config.bucketName,
      Prefix: dataset.s3_prefix
    };
    
    const listedObjects = await s3.listObjectsV2(listParams).promise();
    
    if (listedObjects.Contents.length > 0) {
      const deleteParams = {
        Bucket: s3Config.bucketName,
        Delete: { Objects: [] }
      };
      
      listedObjects.Contents.forEach(({ Key }) => {
        deleteParams.Delete.Objects.push({ Key });
      });
      
      await s3.deleteObjects(deleteParams).promise();
    }
    
    // 如果数据集有关联的模型，也标记为删除
    await pool.query(
      'UPDATE clip_models SET status = ? WHERE dataset_id = ?',
      ['deleted', datasetId]
    );
    
    // 从数据库中删除数据集
    await pool.query('DELETE FROM training_datasets WHERE id = ?', [datasetId]);
    
    res.json({ message: '数据集已成功删除' });
    
  } catch (error) {
    console.error('删除数据集错误:', error);
    res.status(500).json({ error: '删除数据集失败' });
  }
});

// 开始训练模型
router.post('/start', authenticateToken, async (req, res) => {
  try {
    const { datasetId } = req.body;
    const userId = req.user.id;
    
    if (!datasetId) {
      return res.status(400).json({ error: '请提供有效的数据集ID' });
    }
    
    // 验证数据集所属和状态
    const [datasets] = await pool.query(
      'SELECT id, name, s3_prefix, status FROM training_datasets WHERE id = ? AND user_id = ?',
      [datasetId, userId]
    );
    
    if (datasets.length === 0) {
      return res.status(404).json({ error: '数据集不存在或无权访问' });
    }
    
    const dataset = datasets[0];
    
    if (dataset.status !== 'ready') {
      return res.status(400).json({ error: '数据集不处于可训练状态' });
    }
    
    // 创建模型ID
    const modelId = uuidv4();
    const modelName = `${dataset.name}-${new Date().toISOString().split('T')[0]}`;
    const modelS3Path = `${awsConfig.modelsPrefix}${userId}/${modelId}/`;
    
    // 创建模型记录
    await pool.query(
      `INSERT INTO clip_models 
       (id, user_id, dataset_id, name, s3_path, status) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [modelId, userId, datasetId, modelName, modelS3Path, 'training']
    );
    
    // 更新数据集状态
    await pool.query(
      'UPDATE training_datasets SET status = ? WHERE id = ?',
      ['training', datasetId]
    );
    
    // 触发异步训练过程
    // 注意：在实际实现中，你需要根据你的微调代码设计来调用适当的脚本或API
    // 这里我们只是模拟异步过程
    setTimeout(async () => {
      try {
        // 模拟训练完成
        console.log(`模型 ${modelId} 的训练已完成`);
        
        // 更新模型和数据集状态
        await pool.query(
          'UPDATE clip_models SET status = ? WHERE id = ?',
          ['ready', modelId]
        );
        
        await pool.query(
          'UPDATE training_datasets SET status = ? WHERE id = ?',
          ['ready', datasetId]
        );
      } catch (error) {
        console.error('更新训练状态错误:', error);
        
        // 更新为错误状态
        await pool.query(
          'UPDATE clip_models SET status = ? WHERE id = ?',
          ['error', modelId]
        );
        
        await pool.query(
          'UPDATE training_datasets SET status = ? WHERE id = ?',
          ['error', datasetId]
        );
      }
    }, 60000); // 模拟1分钟的训练时间
    
    res.json({
      id: modelId,
      message: '模型训练任务已提交',
      modelName
    });
    
  } catch (error) {
    console.error('启动训练错误:', error);
    res.status(500).json({ error: '启动训练失败' });
  }
});

// 获取用户的模型列表
router.get('/models', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [models] = await pool.query(
      `SELECT m.id, m.name, m.status, m.created_at, m.endpoint_name, 
              m.endpoint_status, t.name as dataset_name, t.id as dataset_id
       FROM clip_models m
       JOIN training_datasets t ON m.dataset_id = t.id
       WHERE m.user_id = ? AND m.status != 'deleted'
       ORDER BY m.created_at DESC`,
      [userId]
    );
    
    // 格式化响应
    const formattedModels = models.map(model => ({
      id: model.id,
      name: model.name,
      basedOn: model.dataset_name,
      datasetId: model.dataset_id,
      status: model.endpoint_name ? 'deployed' : model.status,
      endpointName: model.endpoint_name,
      endpointStatus: model.endpoint_status,
      createdAt: model.created_at
    }));
    
    res.json(formattedModels);
    
  } catch (error) {
    console.error('获取模型列表错误:', error);
    res.status(500).json({ error: '获取模型列表失败' });
  }
});

// 部署模型到SageMaker端点
router.post('/deploy', authenticateToken, async (req, res) => {
  try {
    const { modelId } = req.body;
    const userId = req.user.id;
    
    if (!modelId) {
      return res.status(400).json({ error: '请提供有效的模型ID' });
    }
    
    // 验证模型所属和状态
    const [models] = await pool.query(
      'SELECT id, name, s3_path, status FROM clip_models WHERE id = ? AND user_id = ? AND status = ?',
      [modelId, userId, 'ready']
    );
    
    if (models.length === 0) {
      return res.status(404).json({ error: '模型不存在、无权访问或不处于可部署状态' });
    }
    
    const model = models[0];
    const endpointName = `clip-${modelId.substring(0, 8)}`;
    
    // 更新模型状态为部署中
    await pool.query(
      'UPDATE clip_models SET status = ?, endpoint_name = ? WHERE id = ?',
      ['deploying', endpointName, modelId]
    );
    
    // 触发异步部署过程
    // 注意：在实际实现中，你需要调用SageMaker API来部署模型
    // 这里我们只是模拟异步过程
    setTimeout(async () => {
      try {
        // 模拟部署完成
        console.log(`模型 ${modelId} 已部署到端点 ${endpointName}`);
        
        // 更新模型状态
        await pool.query(
          'UPDATE clip_models SET status = ?, endpoint_status = ? WHERE id = ?',
          ['ready', 'InService', modelId]
        );
      } catch (error) {
        console.error('更新部署状态错误:', error);
        
        // 更新为错误状态
        await pool.query(
          'UPDATE clip_models SET status = ?, endpoint_status = ? WHERE id = ?',
          ['error', 'Failed', modelId]
        );
      }
    }, 45000); // 模拟45秒的部署时间
    
    res.json({
      endpointName,
      message: '模型部署任务已提交'
    });
    
  } catch (error) {
    console.error('部署模型错误:', error);
    res.status(500).json({ error: '部署模型失败' });
  }
});

// 取消部署模型（停止端点）
router.post('/undeploy', authenticateToken, async (req, res) => {
  try {
    const { modelId } = req.body;
    const userId = req.user.id;
    
    if (!modelId) {
      return res.status(400).json({ error: '请提供有效的模型ID' });
    }
    
    // 验证模型所属和状态
    const [models] = await pool.query(
      'SELECT id, endpoint_name FROM clip_models WHERE id = ? AND user_id = ? AND endpoint_name IS NOT NULL',
      [modelId, userId]
    );
    
    if (models.length === 0) {
      return res.status(404).json({ error: '模型不存在、无权访问或未部署' });
    }
    
    const endpointName = models[0].endpoint_name;
    
    // 在实际实现中，你需要调用SageMaker API来停止端点
    // const deleteEndpointParams = {
    //   EndpointName: endpointName
    // };
    // await sageMaker.deleteEndpoint(deleteEndpointParams).promise();
    
    // 更新模型状态
    await pool.query(
      'UPDATE clip_models SET endpoint_name = NULL, endpoint_status = NULL WHERE id = ?',
      [modelId]
    );
    
    res.json({
      message: `端点 ${endpointName} 已停止`
    });
    
  } catch (error) {
    console.error('取消部署模型错误:', error);
    res.status(500).json({ error: '取消部署模型失败' });
  }
});

// 删除模型
router.delete('/models/:id', authenticateToken, async (req, res) => {
  try {
    const modelId = req.params.id;
    const userId = req.user.id;
    
    // 验证模型所属
    const [models] = await pool.query(
      'SELECT s3_path, status, endpoint_name FROM clip_models WHERE id = ? AND user_id = ?',
      [modelId, userId]
    );
    
    if (models.length === 0) {
      return res.status(404).json({ error: '模型不存在或无权访问' });
    }
    
    const model = models[0];
    
    // 不允许删除正在训练或部署中的模型
    if (['training', 'deploying'].includes(model.status)) {
      return res.status(400).json({ error: '无法删除正在处理中的模型' });
    }
    
    // 如果模型已部署，先停止端点
    if (model.endpoint_name) {
      // 在实际实现中，你需要调用SageMaker API来停止端点
      // const deleteEndpointParams = {
      //   EndpointName: model.endpoint_name
      // };
      // await sageMaker.deleteEndpoint(deleteEndpointParams).promise();
    }
    
    // 列出并删除S3中的所有相关对象
    const listParams = {
      Bucket: s3Config.bucketName,
      Prefix: model.s3_path
    };
    
    const listedObjects = await s3.listObjectsV2(listParams).promise();
    
    if (listedObjects.Contents.length > 0) {
      const deleteParams = {
        Bucket: s3Config.bucketName,
        Delete: { Objects: [] }
      };
      
      listedObjects.Contents.forEach(({ Key }) => {
        deleteParams.Delete.Objects.push({ Key });
      });
      
      await s3.deleteObjects(deleteParams).promise();
    }
    
    // 从数据库中标记模型为已删除
    await pool.query(
      'UPDATE clip_models SET status = ?, endpoint_name = NULL, endpoint_status = NULL WHERE id = ?',
      ['deleted', modelId]
    );
    
    res.json({ message: '模型已成功删除' });
    
  } catch (error) {
    console.error('删除模型错误:', error);
    res.status(500).json({ error: '删除模型失败' });
  }
});

module.exports = router;

// 验证 token 的中间件
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  const jwt = require('jsonwebtoken');
  jwt.verify(token, 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({ error: '无效的认证令牌' });
    }
    req.user = user;
    next();
  });
} 