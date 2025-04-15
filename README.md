# CLIP图像搜索应用

## Project setup
```
npm install
```

### Compiles and hot-reloads for development
```
npm run serve
```

### Compiles and minifies for production
```
npm run build
```

### Lints and fixes files
```
npm run lint
```

### Customize configuration
See [Configuration Reference](https://cli.vuejs.org/config/).

## 环境变量配置

本项目使用环境变量管理敏感配置信息，如AWS密钥等。请按照以下步骤设置：

1. 复制`.env.example`文件为`.env`：

```bash
cp backend/.env.example backend/.env
```

2. 在`.env`文件中填入您的实际配置值：

```
AWS_REGION=your_region
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
S3_BUCKET=your_bucket_name
SAGEMAKER_ROLE=your_sagemaker_role
```

**重要提示：** 不要将包含敏感信息的`.env`文件提交到版本控制系统中！
