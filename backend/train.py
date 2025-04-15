import os
import json
import torch
import torch.nn as nn
import clip
from PIL import Image
import argparse
from torch.utils.data import Dataset, DataLoader
import logging
import zipfile
import boto3
import numpy as np
from tqdm import tqdm

# 设置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def extract_dataset(input_data_dir):
    """从SageMaker提供的输入目录提取数据集"""
    logger.info(f"正在从 {input_data_dir} 提取数据集")
    
    # 检查是否有zip文件
    zip_files = [f for f in os.listdir(input_data_dir) if f.endswith('.zip')]
    
    if zip_files:
        logger.info(f"找到ZIP文件: {zip_files[0]}")
        zip_path = os.path.join(input_data_dir, zip_files[0])
        extract_dir = os.path.join('/tmp', 'dataset')
        os.makedirs(extract_dir, exist_ok=True)
        
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(extract_dir)
        
        logger.info(f"数据集已解压到: {extract_dir}")
        return extract_dir
    else:
        logger.info("未找到ZIP文件，使用输入目录作为数据集目录")
        return input_data_dir

def prepare_dataset(data_dir):
    """准备数据集，划分为训练、验证和测试集"""
    logger.info(f"正在准备数据集: {data_dir}")
    
    # 查找annotations.json文件
    annotations_path = os.path.join(data_dir, 'annotations.json')
    if not os.path.exists(annotations_path):
        logger.error(f"找不到annotations.json文件: {annotations_path}")
        raise FileNotFoundError(f"找不到annotations.json文件: {annotations_path}")
    
    # 读取JSON文件
    with open(annotations_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # 检查文件结构
    if isinstance(data, dict) and 'images' in data:
        # 如果是嵌套结构，提取images列表
        data = data['images']
    
    # 过滤并只保留必要的字段
    filtered_data = []
    for item in data:
        if isinstance(item, dict) and 'image_path' in item and 'product_title' in item:
            filtered_data.append({
                'image_path': item['image_path'],
                'product_title': item['product_title']
            })
    
    # 打乱并划分数据集
    np.random.shuffle(filtered_data)
    n = len(filtered_data)
    train_data = filtered_data[:int(0.7 * n)]
    val_data = filtered_data[int(0.7 * n):int(0.85 * n)]
    test_data = filtered_data[int(0.85 * n):]
    
    # 创建JSON文件
    os.makedirs('/tmp/data', exist_ok=True)
    
    def save_jsonl(data, filepath):
        with open(filepath, 'w', encoding='utf-8') as f:
            for item in data:
                f.write(json.dumps(item) + '\n')
    
    train_path = '/tmp/data/train_data.json'
    val_path = '/tmp/data/val_data.json'
    test_path = '/tmp/data/test_data.json'
    
    save_jsonl(train_data, train_path)
    save_jsonl(val_data, val_path)
    save_jsonl(test_data, test_path)
    
    logger.info(f"数据集已划分: 训练集 {len(train_data)}, 验证集 {len(val_data)}, 测试集 {len(test_data)}")
    return {
        'train_path': train_path,
        'val_path': val_path,
        'test_path': test_path,
        'image_dir': os.path.join(data_dir, 'images')
    }

class FashionDataset(Dataset):
    def __init__(self, jsonl_path, image_root, preprocess_fn):
        self.image_paths = []
        self.texts = []
        self.preprocess = preprocess_fn
        
        # 读取JSONL文件
        with open(jsonl_path, 'r') as f:
            for line in f:
                item = json.loads(line)
                img_name = os.path.basename(item['image_path'])
                img_path = os.path.join(image_root, img_name)
                
                if not os.path.exists(img_path):
                    # 尝试从原始路径加载
                    img_path = os.path.join(image_root, item['image_path'])
                    if not os.path.exists(img_path):
                        continue
                
                # 使用product_title作为caption
                caption = f"{item['product_title'][:77]}"
                self.image_paths.append(img_path)
                self.texts.append(caption)
        
        # 一次性tokenize文本
        self.tokenized_texts = clip.tokenize(self.texts)
        logger.info(f"加载了 {len(self.image_paths)} 个图像-文本对")

    def __len__(self):
        return len(self.image_paths)

    def __getitem__(self, idx):
        try:
            image = self.preprocess(Image.open(self.image_paths[idx]).convert("RGB"))
            text = self.tokenized_texts[idx]
            return image, text
        except Exception as e:
            logger.error(f"加载图像错误 {self.image_paths[idx]}: {e}")
            # 返回一个替代项
            return torch.zeros(3, 224, 224), self.tokenized_texts[0]

def evaluate(model, val_dataset, device, topk=(1, 5, 10)):
    model.eval()
    with torch.no_grad():
        # 提取所有图片特征
        all_image_features = []
        for images, _ in DataLoader(val_dataset, batch_size=64):
            images = images.to(device)
            with torch.amp.autocast(device.type):
                image_feat = model.encode_image(images)
                image_feat /= image_feat.norm(dim=-1, keepdim=True)
            all_image_features.append(image_feat)
        
        image_features = torch.cat(all_image_features, dim=0)  # (N_img, D)
        
        # 对每个文本提取特征，并匹配所有图像
        topk_correct = {k: 0 for k in topk}
        total = len(val_dataset)
        
        for idx in range(total):
            text = val_dataset.tokenized_texts[idx].unsqueeze(0).to(device)
            with torch.amp.autocast(device.type):
                text_feat = model.encode_text(text)
                text_feat /= text_feat.norm(dim=-1, keepdim=True)
            
            similarity = text_feat @ image_features.T  # (1, N_img)
            values, indices = similarity.topk(max(topk), dim=-1)
            
            for k in topk:
                if idx in indices[0][:k]:
                    topk_correct[k] += 1
        
        accs = {f"top{k}": topk_correct[k] / total for k in topk}
        return accs

def train(args):
    # 设置设备 - 强制使用CPU
    device = torch.device("cpu")
    logger.info(f"使用设备: {device}")
    
    # 提取数据集
    dataset_dir = extract_dataset(args.train)
    dataset_paths = prepare_dataset(dataset_dir)
    
    # 加载CLIP模型
    model, preprocess = clip.load("ViT-B/32", device=device, jit=False)
    model = model.to(device)
    model = model.float()
    model.train()
    
    # 创建数据集
    train_dataset = FashionDataset(
        dataset_paths['train_path'], 
        dataset_paths['image_dir'], 
        preprocess
    )
    val_dataset = FashionDataset(
        dataset_paths['val_path'], 
        dataset_paths['image_dir'], 
        preprocess
    )
    
    train_loader = DataLoader(
        train_dataset, 
        batch_size=args.batch_size, 
        shuffle=True, 
        num_workers=args.workers
    )
    
    # 定义损失函数和优化器
    loss_img = nn.CrossEntropyLoss()
    loss_txt = nn.CrossEntropyLoss()
    optimizer = torch.optim.AdamW(
        model.parameters(), 
        lr=args.learning_rate, 
        betas=(0.9, 0.98), 
        eps=1e-6, 
        weight_decay=0.2
    )
    
    # 使用混合精度训练
    scaler = torch.amp.GradScaler()
    
    # 训练循环
    best_top1 = 0.0
    
    for epoch in range(args.epochs):
        model.train()
        total_loss = 0
        correct = 0
        total = 0
        pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}/{args.epochs}")
        
        for images, texts in pbar:
            images, texts = images.to(device), texts.to(device)
            optimizer.zero_grad()
            ground_truth = torch.arange(len(images), device=device)
            
            with torch.amp.autocast(device.type):
                logits_per_image, logits_per_text = model(images, texts)
                loss = (loss_img(logits_per_image, ground_truth) + 
                        loss_txt(logits_per_text, ground_truth)) / 2
            
            scaler.scale(loss).backward()
            
            # 梯度裁剪
            scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
            
            scaler.step(optimizer)
            scaler.update()
            
            # 计算top-1 acc
            _, pred = logits_per_image.softmax(dim=-1).max(dim=-1)
            correct += (pred == ground_truth).sum().item()
            total += len(images)
            
            total_loss += loss.item()
            pbar.set_postfix(loss=loss.item(), acc=f"{100*correct/total:.2f}%")
        
        epoch_loss = total_loss / len(train_loader)
        epoch_acc = 100 * correct / total
        logger.info(f"Epoch {epoch+1} - Loss: {epoch_loss:.4f}, Acc: {epoch_acc:.2f}%")
        
        # 验证
        accs = evaluate(model, val_dataset, device)
        val_top1 = accs["top1"]
        logger.info(f"Validation - Top1: {val_top1*100:.2f}%, Top5: {accs['top5']*100:.2f}%")
        
        # 保存最佳模型
        if val_top1 > best_top1:
            best_top1 = val_top1
            # SageMaker会自动保存/opt/ml/model/目录下的内容
            model_path = os.path.join(args.model_dir, 'model.pt')
            torch.save({
                'epoch': epoch,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'val_top1': val_top1
            }, model_path)
            logger.info(f"保存最佳模型到 {model_path}")
    
    # 保存最终模型
    final_model_path = os.path.join(args.model_dir, 'model_final.pt')
    torch.save({
        'epoch': args.epochs,
        'model_state_dict': model.state_dict(),
        'optimizer_state_dict': optimizer.state_dict(),
        'val_top1': val_top1
    }, final_model_path)
    logger.info(f"保存最终模型到 {final_model_path}")
    
    # 导出为TorchScript模型，便于部署
    model.eval()
    sample_input = torch.zeros(1, 3, 224, 224).to(device)
    with torch.no_grad():
        model_scripted = torch.jit.trace(model.encode_image, sample_input)
    
    script_model_path = os.path.join(args.model_dir, 'model.scripted.pt')
    model_scripted.save(script_model_path)
    logger.info(f"保存TorchScript模型到 {script_model_path}")
    
    # 将模型打包成tar.gz
    try:
        import tarfile
        with tarfile.open(os.path.join(args.model_dir, "model.tar.gz"), "w:gz") as tar:
            tar.add(model_path, arcname=os.path.basename(model_path))
    except Exception as e:
        logger.error(f"打包模型时出错: {e}")
    
    # 将模型和训练配置保存到一个目录中
    model_info = {
        'clip_model_type': 'ViT-B/32',
        'epochs': args.epochs,
        'batch_size': args.batch_size,
        'learning_rate': args.learning_rate,
        'val_top1': best_top1
    }
    
    with open(os.path.join(args.model_dir, 'model_info.json'), 'w') as f:
        json.dump(model_info, f)
    
    # 准备模型工件
    prepare_model_artifacts(args.model_dir)
    
    return model

def prepare_model_artifacts(model_dir):
    """准备模型工件，复制推理代码到模型目录中"""
    code_dir = os.path.join(model_dir, 'code')
    os.makedirs(code_dir, exist_ok=True)
    
    # 创建inference.py
    inference_code = """
import os
import json
import torch
import clip
from PIL import Image
import io
import base64
import numpy as np

def model_fn(model_dir):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    # 加载模型信息
    with open(os.path.join(model_dir, 'model_info.json'), 'r') as f:
        model_info = json.load(f)
    
    # 加载基础CLIP模型
    model, preprocess = clip.load(model_info['clip_model_type'], device=device, jit=False)
    
    # 加载微调的权重
    checkpoint = torch.load(os.path.join(model_dir, 'model.pt'), map_location=device)
    model.load_state_dict(checkpoint['model_state_dict'])
    model.eval()
    
    return {
        'model': model,
        'preprocess': preprocess,
        'device': device
    }

def input_fn(request_body, request_content_type):
    if request_content_type == 'application/json':
        data = json.loads(request_body)
        
        # 解码图像
        if 'image' in data:
            image_bytes = base64.b64decode(data['image'])
            image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        else:
            image = None
        
        # 获取文本
        text = data.get('text', '')
        
        return {'image': image, 'text': text}
    else:
        raise ValueError(f"不支持的内容类型: {request_content_type}")

def predict_fn(input_data, model_dict):
    model = model_dict['model']
    preprocess = model_dict['preprocess']
    device = model_dict['device']
    
    image = input_data['image']
    text = input_data['text']
    
    with torch.no_grad():
        # 处理图像
        if image is not None:
            image_tensor = preprocess(image).unsqueeze(0).to(device)
            image_features = model.encode_image(image_tensor)
            image_features /= image_features.norm(dim=-1, keepdim=True)
        
        # 处理文本
        if text:
            text_tensor = clip.tokenize([text]).to(device)
            text_features = model.encode_text(text_tensor)
            text_features /= text_features.norm(dim=-1, keepdim=True)
        
        # 如果同时有图像和文本，计算相似度
        if image is not None and text:
            similarity = (image_features @ text_features.T).item()
        else:
            similarity = None
        
        result = {
            'similarity': similarity
        }
        
        # 返回特征向量（可选）
        if image is not None:
            result['image_features'] = image_features.cpu().numpy().tolist()
        if text:
            result['text_features'] = text_features.cpu().numpy().tolist()
            
        return result

def output_fn(prediction, response_content_type):
    if response_content_type == 'application/json':
        return json.dumps(prediction), response_content_type
    else:
        raise ValueError(f"不支持的内容类型: {response_content_type}")
"""
    
    with open(os.path.join(code_dir, 'inference.py'), 'w') as f:
        f.write(inference_code)
    
    # 创建requirements.txt
    requirements = """
torch>=1.10.0
torchvision>=0.11.1
Pillow>=8.4.0
numpy>=1.21.0
git+https://github.com/openai/CLIP.git
"""
    
    with open(os.path.join(code_dir, 'requirements.txt'), 'w') as f:
        f.write(requirements)
    
    # 创建serve文件(入口点)
    serve_script = """#!/bin/bash
cd /opt/ml/model/code
pip install -r requirements.txt
cp -r /opt/ml/model/* /opt/program/
"""
    
    with open(os.path.join(code_dir, 'serve'), 'w') as f:
        f.write(serve_script)
    
    # 设置执行权限
    os.chmod(os.path.join(code_dir, 'serve'), 0o755)
    
    logger.info(f"模型工件已准备完成: {code_dir}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    
    # 数据、模型和输出目录
    parser.add_argument('--model-dir', type=str, default=os.environ.get('SM_MODEL_DIR', '/opt/ml/model'))
    parser.add_argument('--train', type=str, default=os.environ.get('SM_CHANNEL_TRAINING', '/opt/ml/input/data/training'))
    
    # 训练超参数
    parser.add_argument('--batch-size', type=int, default=32)
    parser.add_argument('--epochs', type=int, default=10)
    parser.add_argument('--learning-rate', type=float, default=5e-6)
    parser.add_argument('--max-grad-norm', type=float, default=1.0)
    parser.add_argument('--workers', type=int, default=4)
    
    args = parser.parse_args()
    
    # 开始训练
    train(args) 