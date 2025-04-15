// SageMaker训练辅助函数
const { s3, sageMaker, s3Config, sageMakerConfig } = require('./aws-config');
const awsConfig = require('./aws-config');
const fs = require('fs');
const path = require('path');

/**
 * 上传训练脚本到S3
 * @param {string} localPath - 本地脚本路径
 * @param {string} s3Key - S3目标路径
 * @returns {string} - S3 URI
 */
async function uploadTrainingScript(localPath, s3Key) {
  try {
    const fileContent = fs.readFileSync(localPath);
    
    await s3.upload({
      Bucket: awsConfig.s3Bucket,
      Key: s3Key,
      Body: fileContent
    }).promise();
    
    return `s3://${awsConfig.s3Bucket}/${s3Key}`;
  } catch (error) {
    console.error('上传训练脚本错误:', error);
    throw error;
  }
}

/**
 * 创建SageMaker训练作业
 * @param {Object} dataset - 数据集信息 {id, name, s3_prefix}
 * @param {Object} model - 模型信息 {id, name, s3_path}
 * @param {Object} hyperParams - 超参数 (可选)
 * @returns {string} - 训练作业名称
 */
async function createTrainingJob(dataset, model, hyperParams = {}) {
  try {
    // 上传训练脚本
    const scriptS3Key = `${awsConfig.modelsPrefix}scripts/train.py`;
    await uploadTrainingScript(path.join(__dirname, 'train.py'), scriptS3Key);
    
    // 创建唯一的训练作业名称
    const trainingJobName = `clip-finetune-${model.id.replace(/-/g, '')}`;
    
    // 数据源和输出路径
    const dataS3Uri = `s3://${awsConfig.s3Bucket}/${dataset.s3_prefix}`;
    const outputS3Uri = `s3://${awsConfig.s3Bucket}/${model.s3_path}`;
    
    // 默认超参数
    const defaultHyperParams = {
      'batch-size': '32',
      'epochs': '10',
      'learning-rate': '5e-6',
      'max-grad-norm': '1.0',
      'workers': '4'
    };
    
    // 合并用户提供的超参数
    const finalHyperParams = {
      ...defaultHyperParams,
      ...hyperParams,
      'sagemaker_program': 'train.py',
      'sagemaker_submit_directory': `s3://${awsConfig.s3Bucket}/${scriptS3Key}`
    };
    
    // 创建训练作业参数
    const trainingParams = {
      TrainingJobName: trainingJobName,
      AlgorithmSpecification: {
        TrainingImage: '763104351884.dkr.ecr.ap-northeast-1.amazonaws.com/pytorch-training:1.10.0-cpu-py38',
        TrainingInputMode: 'File',
        EnableSageMakerMetricsTimeSeries: true
      },
      RoleArn: sageMakerConfig.roleArn,
      InputDataConfig: [
        {
          ChannelName: 'training',
          DataSource: {
            S3DataSource: {
              S3DataType: 'S3Prefix',
              S3Uri: dataS3Uri,
              S3DataDistributionType: 'FullyReplicated'
            }
          },
          CompressionType: 'None'
        }
      ],
      OutputDataConfig: {
        S3OutputPath: outputS3Uri
      },
      ResourceConfig: {
        InstanceType: "ml.m5.large",
        InstanceCount: 1,
        VolumeSizeInGB: 30
      },
      StoppingCondition: {
        MaxRuntimeInSeconds: 86400 // 24小时
      },
      HyperParameters: finalHyperParams
    };
    
    // 创建训练作业
    await sageMaker.createTrainingJob(trainingParams).promise();
    console.log(`创建训练作业: ${trainingJobName}`);
    
    return trainingJobName;
  } catch (error) {
    console.error('创建训练作业错误:', error);
    throw error;
  }
}

/**
 * 获取训练作业状态
 * @param {string} trainingJobName - 训练作业名称
 * @returns {Object} - 训练作业状态
 */
async function getTrainingJobStatus(trainingJobName) {
  try {
    const response = await sageMaker.describeTrainingJob({ TrainingJobName: trainingJobName }).promise();
    
    return {
      status: response.TrainingJobStatus,
      reason: response.FailureReason,
      metrics: response.FinalMetricDataList,
      modelArtifacts: response.ModelArtifacts,
      secondaryStatus: response.SecondaryStatus
    };
  } catch (error) {
    console.error(`获取训练作业状态错误 ${trainingJobName}:`, error);
    throw error;
  }
}

/**
 * 取消训练作业
 * @param {string} trainingJobName - 训练作业名称
 * @returns {boolean} - 是否成功取消
 */
async function stopTrainingJob(trainingJobName) {
  try {
    await sageMaker.stopTrainingJob({ TrainingJobName: trainingJobName }).promise();
    console.log(`停止训练作业: ${trainingJobName}`);
    return true;
  } catch (error) {
    console.error(`停止训练作业错误 ${trainingJobName}:`, error);
    throw error;
  }
}

module.exports = {
  uploadTrainingScript,
  createTrainingJob,
  getTrainingJobStatus,
  stopTrainingJob
};