// AWS 服务配置
module.exports = {
  region: process.env.AWS_REGION || 'ap-northeast-1',
  s3Bucket: process.env.S3_BUCKET || 'cp10bucket',
  sagemakerRole: process.env.SAGEMAKER_ROLE || 'arn:aws:iam::490004625466:role/service-role/AmazonSageMakerServiceCatalogProductsUseRole',
  trainingImage: '763104351884.dkr.ecr.ap-northeast-1.amazonaws.com/pytorch-training:1.10.0-cpu-py38',
  inferenceImage: '763104351884.dkr.ecr.ap-northeast-1.amazonaws.com/pytorch-inference:1.10.0-cpu-py38',
  trainingInstanceType: process.env.TRAINING_INSTANCE_TYPE || 'ml.m5.large',
  inferenceInstanceType: process.env.INFERENCE_INSTANCE_TYPE || 'ml.m5.large',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  modelsPrefix: 'models/',
  datasetsPrefix: 'datasets/',
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
};