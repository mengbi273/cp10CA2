from flask import Flask, request, jsonify
from flask_cors import CORS
import torch
from PIL import Image
import clip
import os
import numpy as np
import boto3
import json
import tempfile
import logging

app = Flask(__name__)
CORS(app)

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# AWS配置（从环境变量获取）
AWS_REGION = os.environ.get('AWS_REGION', 'ap-northeast-1')
AWS_ACCESS_KEY_ID = os.environ.get('AWS_ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = os.environ.get('AWS_SECRET_ACCESS_KEY')

# 创建S3和SageMaker客户端
s3_client = boto3.client(
    's3',
    region_name=AWS_REGION,
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY
)
sagemaker_runtime = boto3.client(
    'sagemaker-runtime',
    region_name=AWS_REGION,
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY
)

# 加载默认CLIP模型
device = "cuda" if torch.cuda.is_available() else "cpu"
model, preprocess = clip.load("ViT-L/14", device=device)

# 已加载的微调模型缓存
fine_tuned_models = {}

@app.route('/api/clip/search', methods=['POST'])
def search():
    try:
        data = request.json
        query = data['query']
        image_paths = data['images']  # 图片路径列表
        min_score = data.get('min_score', 0.155)  # 获取最小相似度阈值，默认0.155
        endpoint_name = data.get('endpoint_name')  # 获取端点名称，如果有的话
        
        logger.info(f"处理 {len(image_paths)} 张图片的CLIP搜索请求，最小相似度阈值: {min_score}")
        if endpoint_name:
            logger.info(f"使用微调模型端点: {endpoint_name}")
            return search_with_endpoint(query, image_paths, min_score, endpoint_name)
        else:
            logger.info("使用默认CLIP模型")
            return search_with_default_model(query, image_paths, min_score)
    
    except Exception as e:
        logger.error(f"CLIP搜索发生错误: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

def search_with_default_model(query, image_paths, min_score):
    # 对文本进行编码
    text = clip.tokenize([query]).to(device)
    with torch.no_grad():
        text_features = model.encode_text(text)
        text_features /= text_features.norm(dim=-1, keepdim=True)

    results = []
    batch_size = 10  # 批处理大小
    
    # 分批处理图片
    for i in range(0, len(image_paths), batch_size):
        batch_paths = image_paths[i:i+batch_size]
        logger.info(f"处理批次 {i//batch_size + 1}/{(len(image_paths)-1)//batch_size + 1}, {len(batch_paths)} 张图片")
        
        batch_images = []
        valid_paths = []
        
        # 预处理批次中的图片
        for img_path in batch_paths:
            try:
                img = preprocess(Image.open(img_path)).unsqueeze(0).to(device)
                batch_images.append(img)
                valid_paths.append(img_path)
            except Exception as e:
                logger.error(f"处理图片 {img_path} 时出错: {str(e)}")
                continue
        
        if not batch_images:
            continue
            
        # 连接批次中的所有图片张量
        batch_tensor = torch.cat(batch_images)
        
        # 对图片批次进行编码
        with torch.no_grad():
            image_features = model.encode_image(batch_tensor)
            image_features /= image_features.norm(dim=-1, keepdim=True)

        # 手动计算余弦相似度（范围在 -1 到 1 之间）
        similarities = text_features @ image_features.T
        
        # 存储结果
        for idx, (path, similarity) in enumerate(zip(valid_paths, similarities.squeeze())):
            similarity_value = float(similarity)
            # 只添加相似度大于等于阈值的结果
            if similarity_value >= min_score:
                results.append({
                    'path': path,
                    'score': similarity_value
                })
            
        # 释放内存
        del batch_images, batch_tensor, image_features
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    # 按相似度排序
    results.sort(key=lambda x: x['score'], reverse=True)
    
    logger.info(f"CLIP搜索完成，找到 {len(results)} 个相似度 >= {min_score} 的结果")
    return jsonify(results)

def search_with_endpoint(query, image_paths, min_score, endpoint_name):
    results = []
    batch_size = 10  # 批处理大小
    
    # 分批处理图片
    for i in range(0, len(image_paths), batch_size):
        batch_paths = image_paths[i:i+batch_size]
        logger.info(f"使用端点处理批次 {i//batch_size + 1}/{(len(image_paths)-1)//batch_size + 1}, {len(batch_paths)} 张图片")
        
        batch_images = []
        valid_paths = []
        
        # 预处理批次中的图片
        for img_path in batch_paths:
            try:
                # 只读取图片数据，不进行预处理（预处理在端点中进行）
                with open(img_path, 'rb') as f:
                    img_data = f.read()
                batch_images.append(img_data)
                valid_paths.append(img_path)
            except Exception as e:
                logger.error(f"处理图片 {img_path} 时出错: {str(e)}")
                continue
        
        if not batch_images:
            continue
        
        # 为每张图片调用端点
        for idx, (img_data, img_path) in enumerate(zip(batch_images, valid_paths)):
            try:
                # 准备请求数据
                payload = {
                    'text': query,
                    'image': img_data.hex()  # 将二进制数据转换为十六进制字符串
                }
                
                # 调用SageMaker端点
                response = sagemaker_runtime.invoke_endpoint(
                    EndpointName=endpoint_name,
                    ContentType='application/json',
                    Body=json.dumps(payload)
                )
                
                # 解析响应
                response_body = json.loads(response['Body'].read())
                similarity_value = float(response_body['similarity'])
                
                # 只添加相似度大于等于阈值的结果
                if similarity_value >= min_score:
                    results.append({
                        'path': img_path,
                        'score': similarity_value
                    })
                    
            except Exception as e:
                logger.error(f"调用端点 {endpoint_name} 处理图片 {img_path} 时出错: {str(e)}")
                continue

    # 按相似度排序
    results.sort(key=lambda x: x['score'], reverse=True)
    
    logger.info(f"通过端点 {endpoint_name} 的CLIP搜索完成，找到 {len(results)} 个相似度 >= {min_score} 的结果")
    return jsonify(results)

@app.route('/api/clip/secondary_search', methods=['POST'])
def secondary_search():
    try:
        data = request.json
        query = data['query']
        primary_results = data['primary_results']  # 第一次搜索的结果
        min_score = data.get('min_score', 0.155)  # 获取最小相似度阈值，默认0.155
        endpoint_name = data.get('endpoint_name')  # 获取端点名称，如果有的话
        
        logger.info(f"处理二次搜索请求，基于 {len(primary_results)} 张图片，最小相似度阈值: {min_score}")
        if endpoint_name:
            logger.info(f"使用微调模型端点: {endpoint_name}")
            # 从primary_results中提取路径
            image_paths = [result['path'] for result in primary_results]
            return search_with_endpoint(query, image_paths, min_score, endpoint_name)
        else:
            logger.info("使用默认CLIP模型")
            return secondary_search_with_default_model(query, primary_results, min_score)
    
    except Exception as e:
        logger.error(f"二次搜索发生错误: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

def secondary_search_with_default_model(query, primary_results, min_score):
    # 对文本进行编码
    text = clip.tokenize([query]).to(device)
    with torch.no_grad():
        text_features = model.encode_text(text)
        text_features /= text_features.norm(dim=-1, keepdim=True)

    results = []
    # 处理每张图片
    for img_data in primary_results:
        try:
            img_path = img_data['path']
            # 读取并预处理图片
            image = preprocess(Image.open(img_path)).unsqueeze(0).to(device)
            
            # 对图片进行编码
            with torch.no_grad():
                image_features = model.encode_image(image)
                image_features /= image_features.norm(dim=-1, keepdim=True)

            # 手动计算余弦相似度
            similarity = (text_features @ image_features.T).item()
            
            # 只添加相似度大于等于阈值的结果
            if similarity >= min_score:
                results.append({
                    'path': img_path,
                    'score': float(similarity)
                })
        except Exception as e:
            logger.error(f"二次搜索处理图片 {img_path} 时出错: {str(e)}")
            continue

    # 按相似度排序
    results.sort(key=lambda x: x['score'], reverse=True)
    
    logger.info(f"二次搜索完成，找到 {len(results)} 个相似度 >= {min_score} 的结果")
    return jsonify(results)

@app.route('/api/clip/models', methods=['GET'])
def get_available_models():
    """获取可用的模型列表，包括默认模型和部署的微调模型"""
    try:
        # 从数据库获取已部署的模型列表（实际实现中需要替换为实际的查询）
        # 这里只是示例数据
        deployed_models = [
            {
                'id': '1',
                'name': 'CLIP默认模型',
                'endpoint_name': None,
                'description': '默认的CLIP ViT-L/14模型',
                'is_default': True
            }
            # 其他部署的模型会从数据库中查询并添加到此列表
        ]
        
        return jsonify(deployed_models)
    
    except Exception as e:
        logger.error(f"获取模型列表错误: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/clip/test-endpoint', methods=['POST'])
def test_endpoint():
    """测试微调模型端点是否可用"""
    try:
        data = request.json
        endpoint_name = data['endpoint_name']
        test_text = data.get('test_text', '测试查询')
        
        if not endpoint_name:
            return jsonify({'error': '请提供端点名称'}), 400
        
        # 创建一个简单的测试请求
        # 使用示例图片进行测试
        test_image_path = os.path.join(os.path.dirname(__file__), 'test_image.jpg')
        
        if not os.path.exists(test_image_path):
            # 如果没有测试图片，创建一个简单的彩色图像
            from PIL import Image
            img = Image.new('RGB', (224, 224), color = 'red')
            img.save(test_image_path)
        
        with open(test_image_path, 'rb') as f:
            img_data = f.read()
        
        # 准备请求数据
        payload = {
            'text': test_text,
            'image': img_data.hex()
        }
        
        # 调用SageMaker端点
        response = sagemaker_runtime.invoke_endpoint(
            EndpointName=endpoint_name,
            ContentType='application/json',
            Body=json.dumps(payload)
        )
        
        # 检查响应状态
        if response['ResponseMetadata']['HTTPStatusCode'] == 200:
            return jsonify({
                'status': 'success',
                'message': '端点测试成功',
                'endpoint_name': endpoint_name
            })
        else:
            return jsonify({
                'status': 'error',
                'message': '端点测试失败',
                'details': response
            }), 500
    
    except Exception as e:
        logger.error(f"测试端点错误: {str(e)}")
        return jsonify({
            'status': 'error',
            'message': '端点测试失败',
            'error': str(e)
        }), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
