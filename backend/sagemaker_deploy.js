// SageMaker模型部署辅助函数
const { s3, sageMaker, s3Config, sageMakerConfig } = require('./aws-config');
const awsConfig = require('./aws-config');
const fs = require('fs');
const path = require('path');

/**
 * 将模型部署到SageMaker端点
 * @param {Object} model - 模型信息 {id, name, s3_path}
 * @returns {Object} - 部署信息 {endpointName, modelName, configName}
 */
async function deployModelToSageMaker(model) {
  try {
    // 创建唯一的模型名称和端点名称
    const sagemakerModelName = `clip-model-${model.id.replace(/-/g, '')}`;
    const endpointConfigName = `${sagemakerModelName}-config`;
    const endpointName = `clip-endpoint-${model.id.replace(/-/g, '')}`.substring(0, 63);
    
    // 模型S3路径
    const modelS3Uri = `s3://${awsConfig.s3Bucket}/${model.s3_path}model.tar.gz`;
    
    // 创建SageMaker模型
    const createModelParams = {
      ModelName: sagemakerModelName,
      PrimaryContainer: {
        Image: '763104351884.dkr.ecr.ap-northeast-1.amazonaws.com/pytorch-inference:1.10.0-cpu-py38',
        ModelDataUrl: modelS3Uri,
        Environment: {
          'SAGEMAKER_PROGRAM': 'inference.py',
          'SAGEMAKER_SUBMIT_DIRECTORY': modelS3Uri,
          'SAGEMAKER_CONTAINER_LOG_LEVEL': '20'
        }
      },
      ExecutionRoleArn: sageMakerConfig.roleArn
    };
    
    await sageMaker.createModel(createModelParams).promise();
    console.log(`创建SageMaker模型: ${sagemakerModelName}`);
    
    // 创建端点配置
    const createEndpointConfigParams = {
      EndpointConfigName: endpointConfigName,
      ProductionVariants: [
        {
          VariantName: 'AllTraffic',
          ModelName: sagemakerModelName,
          InstanceType: 'ml.m5.large', // 使用CPU实例以节省成本
          InitialInstanceCount: 1
        }
      ]
    };
    
    await sageMaker.createEndpointConfig(createEndpointConfigParams).promise();
    console.log(`创建SageMaker端点配置: ${endpointConfigName}`);
    
    // 创建端点
    const createEndpointParams = {
      EndpointName: endpointName,
      EndpointConfigName: endpointConfigName
    };
    
    await sageMaker.createEndpoint(createEndpointParams).promise();
    console.log(`创建SageMaker端点: ${endpointName}`);
    
    return {
      endpointName,
      modelName: sagemakerModelName,
      configName: endpointConfigName
    };
  } catch (error) {
    console.error('部署模型错误:', error);
    throw error;
  }
}

/**
 * 获取SageMaker端点状态
 * @param {string} endpointName - 端点名称
 * @returns {string} - 端点状态
 */
async function getEndpointStatus(endpointName) {
  try {
    const response = await sageMaker.describeEndpoint({ EndpointName: endpointName }).promise();
    return response.EndpointStatus;
  } catch (error) {
    console.error(`获取端点状态错误 ${endpointName}:`, error);
    throw error;
  }
}

/**
 * 删除SageMaker端点及相关资源
 * @param {Object} deployment - 部署信息 {endpointName, modelName, configName}
 * @returns {boolean} - 是否成功删除
 */
async function deleteEndpoint(deployment) {
    try {
      // 删除端点
      if (deployment.endpointName) {
        await sageMaker.deleteEndpoint({ EndpointName: deployment.endpointName }).promise();
        console.log(`删除端点: ${deployment.endpointName}`);
      }
      
      // 删除端点配置
      if (deployment.configName) {
        await sageMaker.deleteEndpointConfig({ EndpointConfigName: deployment.configName }).promise();
        console.log(`删除端点配置: ${deployment.configName}`);
      }
      
      // 删除模型
      if (deployment.modelName) {
        await sageMaker.deleteModel({ ModelName: deployment.modelName }).promise();
        console.log(`删除模型: ${deployment.modelName}`);
      }
      
      return true;
    } catch (error) {
      console.error('删除端点错误:', error);
      throw error;
    }
  }
  
  /**
   * 调用SageMaker端点进行推理
   * @param {string} endpointName - 端点名称
   * @param {Object} payload - 请求负载
   * @returns {Object} - 推理结果
   */
  async function invokeEndpoint(endpointName, payload) {
    try {
      const params = {
        EndpointName: endpointName,
        ContentType: 'application/json',
        Body: JSON.stringify(payload)
      };
      
      const response = await sageMaker.invokeEndpoint(params).promise();
      return JSON.parse(response.Body.toString());
    } catch (error) {
      console.error(`调用端点错误 ${endpointName}:`, error);
      throw error;
    }
  }
  
  /**
   * 准备模型文件并上传到S3
   * @param {string} modelDir - 模型目录
   * @param {string} s3Key - S3目标路径
   * @returns {string} - S3 URI
   */
  async function prepareAndUploadModel(modelDir, s3Key) {
    try {
      const os = require('os');
      const tar = require('tar');
      
      // 创建临时目录
      const tempDir = path.join(os.tmpdir(), `model-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      
      // 复制模型文件到临时目录
      fs.copyFileSync(
        path.join(modelDir, 'model.pt'),
        path.join(tempDir, 'model.pt')
      );
      
      // 创建tar.gz文件
      const tarFile = path.join(os.tmpdir(), `model-${Date.now()}.tar.gz`);
      await tar.create(
        {
          gzip: true,
          file: tarFile,
          cwd: tempDir
        },
        ['.']
      );
      
      // 上传到S3
      const fileContent = fs.readFileSync(tarFile);
      await s3.upload({
        Bucket: awsConfig.s3Bucket,
        Key: s3Key,
        Body: fileContent
      }).promise();
      
      // 清理临时文件
      fs.unlinkSync(tarFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
      
      return `s3://${awsConfig.s3Bucket}/${s3Key}`;
    } catch (error) {
      console.error('准备并上传模型错误:', error);
      throw error;
    }
  }
  
  /**
   * 更新 training-routes.js 中的部署端点代码
   * @param {Object} pool - 数据库连接池
   * @param {string} modelId - 模型ID
   * @param {Object} deployment - 部署信息 {endpointName, modelName, configName}
   */
  async function updateDeploymentStatus(pool, modelId, deployment) {
    try {
      await pool.query(
        'UPDATE clip_models SET endpoint_name = ?, endpoint_status = ?, status = ? WHERE id = ?',
        [deployment.endpointName, 'Creating', 'deploying', modelId]
      );
      console.log(`更新模型部署状态: ${modelId}`);
    } catch (error) {
      console.error('更新部署状态错误:', error);
      throw error;
    }
  }
  
  /**
   * 轮询端点状态直到完成
   * @param {Object} pool - 数据库连接池
   * @param {string} endpointName - 端点名称
   * @param {string} modelId - 模型ID
   * @param {number} maxAttempts - 最大尝试次数
   * @param {number} delay - 检查间隔（毫秒）
   */
  async function pollEndpointStatus(pool, endpointName, modelId, maxAttempts = 60, delay = 60000) {
    let attempts = 0;
    
    const checkStatus = async () => {
      try {
        attempts++;
        const status = await getEndpointStatus(endpointName);
        console.log(`端点 ${endpointName} 状态 (${attempts}/${maxAttempts}): ${status}`);
        
        if (status === 'InService') {
          // 部署成功
          await pool.query(
            'UPDATE clip_models SET endpoint_status = ?, status = ? WHERE id = ?',
            ['InService', 'deployed', modelId]
          );
          console.log(`端点 ${endpointName} 部署成功`);
          return;
        } else if (status === 'Failed' || status === 'OutOfService') {
          // 部署失败
          await pool.query(
            'UPDATE clip_models SET endpoint_status = ?, status = ? WHERE id = ?',
            [status, 'error', modelId]
          );
          console.log(`端点 ${endpointName} 部署失败: ${status}`);
          return;
        } else if (attempts >= maxAttempts) {
          // 超过最大尝试次数
          console.log(`端点 ${endpointName} 检查超时`);
          return;
        } else {
          // 继续检查
          setTimeout(checkStatus, delay);
        }
      } catch (error) {
        console.error(`检查端点状态错误: ${error}`);
        
        if (attempts >= maxAttempts) {
          // 超过最大尝试次数
          await pool.query(
            'UPDATE clip_models SET endpoint_status = ?, status = ? WHERE id = ?',
            ['Error', 'error', modelId]
          );
          console.log(`端点 ${endpointName} 检查失败`);
        } else {
          // 继续检查
          setTimeout(checkStatus, delay);
        }
      }
    };
    
    // 开始检查
    checkStatus();
  }
  
  module.exports = {
    deployModelToSageMaker,
    getEndpointStatus,
    deleteEndpoint,
    invokeEndpoint,
    prepareAndUploadModel,
    updateDeploymentStatus,
    pollEndpointStatus
  };