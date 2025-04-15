import os
import json
import shutil
import random

# === 配置参数 ===
json_file = "annotations.json"       # 原始 JSON 文件路径
image_base_dir = "images"          # 图片目录（原始图片路径指向这个文件夹）
output_dir = "output"              # 输出目录，会自动创建

# === 创建输出子文件夹 ===
os.makedirs(output_dir, exist_ok=True)
for split in ["train", "val", "test"]:
    os.makedirs(os.path.join(output_dir, "images", split), exist_ok=True)

# === 读取 JSON 文件 ===
with open(json_file, "r", encoding="utf-8") as f:
    data = json.load(f)

# === 只保留必要字段 ===
filtered_data = [{"image_path": item["image_path"], "product_title": item["product_title"]} for item in data]

# === 打乱并划分数据集 ===
random.shuffle(filtered_data)
n = len(filtered_data)
train_data = filtered_data[:int(0.7 * n)]
val_data = filtered_data[int(0.7 * n):int(0.85 * n)]
test_data = filtered_data[int(0.85 * n):]

# === 保存为 JSON 文件 ===
def save_json(data, filename):
    with open(os.path.join(output_dir, filename), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

save_json(train_data, "train.json")
save_json(val_data, "val.json")
save_json(test_data, "test.json")

# === 复制图片到对应目录 ===
def copy_images(data, split):
    for item in data:
        src_path = os.path.join(image_base_dir, os.path.basename(item["image_path"]))
        dst_path = os.path.join(output_dir, "images", split, os.path.basename(item["image_path"]))
        if os.path.exists(src_path):
            shutil.copy(src_path, dst_path)
        else:
            print(f"⚠️ 图片不存在: {src_path}")

copy_images(train_data, "train")
copy_images(val_data, "val")
copy_images(test_data, "test")


import json
from PIL import Image
import torch
import torch.nn as nn
import clip
from transformers import CLIPProcessor,CLIPModel
from tqdm import tqdm
import os
import matplotlib.pyplot as plt
from torch.utils.data import Dataset, DataLoader

model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
# Setting our device to GPU (Cuda) and loading the pre-trained CLIP model.

device = "cuda:0" if torch.cuda.is_available() else "cpu" 

model, preprocess = clip.load("ViT-B/32", device=device, jit=False)

optimizer = torch.optim.Adam(
    model.parameters(), lr=5e-5, betas=(0.9, 0.98), eps=1e-6 ,weight_decay=0.2) 

# 为显存优化设置环境变量（必须在导入 torch 前设置）
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"

# 超参数
BATCH_SIZE = 32
NUM_EPOCHS = 2
LR = 5e-6
MAX_GRAD_NORM = 1.0
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# 加载 CLIP 模型和预处理器
model, preprocess = clip.load("ViT-B/32", device=DEVICE, jit=False)
model = model.to(DEVICE)
model = model.float() 
model.train()

# 加载训练数据
json_path = "./train_data.json"
image_root = "./images/train/"

input_data = []
with open(json_path, 'r') as f:
    for line in f:
        obj = json.loads(line)
        input_data.append(obj)

# 加载验证数据
val_json_path = "./val_data.json"
val_image_root = "./images/val/"

val_data = []
with open(val_json_path, 'r') as f:
    for line in f:
        val_data.append(json.loads(line))

# 加载验证数据
test_json_path = "./test_data.json"
test_image_root = "./images/test/"

test_data = []
with open(test_json_path, 'r') as f:
    for line in f:
        test_data.append(json.loads(line))

def evaluate(model, val_dataset, topk=(1, 5, 10, 20)):
    model.eval()
    with torch.no_grad():
        # Step 1: 提取所有图片特征
        all_image_features = []
        image_paths = []

        for image, _ in DataLoader(val_dataset, batch_size=64):
            image = image.to(DEVICE)
            with torch.amp.autocast(DEVICE):
                image_feat = model.encode_image(image)
                image_feat /= image_feat.norm(dim=-1, keepdim=True)
            all_image_features.append(image_feat)

        image_features = torch.cat(all_image_features, dim=0)  # (N_img, D)

        # Step 2: 对每个文本提取特征，并匹配所有图像
        topk_correct = {k: 0 for k in topk}
        total = len(val_dataset)

        for idx in range(total):
            text = val_dataset.tokenized_texts[idx].unsqueeze(0).to(DEVICE)  # (1, context_length)
            with torch.amp.autocast(DEVICE):
                text_feat = model.encode_text(text)
                text_feat /= text_feat.norm(dim=-1, keepdim=True)

            similarity = text_feat @ image_features.T  # (1, N_img)
            values, indices = similarity.topk(max(topk), dim=-1)  # indices: (1, topk)

            for k in topk:
                if idx in indices[0][:k]:
                    topk_correct[k] += 1

        accs = {f"top{k}": topk_correct[k] / total for k in topk}
        return accs


# 构建 Dataset
class FashionDataset(Dataset):
    def __init__(self, data, image_root):
        self.image_paths = []
        self.texts = []

        for item in data:
            img_name = os.path.basename(item['image_path'])
            img_path = os.path.join(image_root, img_name)

            if not os.path.exists(img_path):
                continue

            # 使用 class label 构造更清晰的文本描述
            #caption = f"a photo of a {item['class_label']}"

            # 使用 product_title作为caption，取前77长度
            caption = f"{item['product_title'][:77]}"
            self.image_paths.append(img_path)
            self.texts.append(caption)

        # 一次性 tokenize 文本
        self.tokenized_texts = clip.tokenize(self.texts)

    def __len__(self):
        return len(self.image_paths)

    def __getitem__(self, idx):
        image = preprocess(Image.open(self.image_paths[idx]).convert("RGB"))
        text = self.tokenized_texts[idx]
        return image, text
    
dataset = FashionDataset(input_data, image_root)
val_dataset = FashionDataset(val_data, val_image_root)
test_dataset = FashionDataset(test_data, test_image_root)

train_loader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)

# Loss & Optimizer
loss_img = nn.CrossEntropyLoss()
loss_txt = nn.CrossEntropyLoss()
optimizer = torch.optim.AdamW(model.parameters(), lr=LR, betas=(0.9, 0.98), eps=1e-6 ,weight_decay=0.2)
scaler = torch.amp.GradScaler()

# 开始训练
val_top1_list = []
val_top5_list = []

for epoch in range(NUM_EPOCHS):
    model.train()
    total_loss = 0
    correct = 0
    total = 0
    pbar = tqdm(train_loader, desc=f"Epoch {epoch+1}/{NUM_EPOCHS}")

    for images, texts in pbar:
        images, texts = images.to(DEVICE), texts.to(DEVICE)
        optimizer.zero_grad()
        ground_truth = torch.arange(len(images), device=DEVICE)

        with torch.amp.autocast(DEVICE):
            logits_per_image, logits_per_text = model(images, texts)
            loss = (loss_img(logits_per_image, ground_truth) + loss_txt(logits_per_text, ground_truth)) / 2

        scaler.scale(loss).backward()

        # 梯度裁剪
        scaler.unscale_(optimizer)
        nn.utils.clip_grad_norm_(model.parameters(), MAX_GRAD_NORM)

        scaler.step(optimizer)
        scaler.update()
        torch.cuda.empty_cache()

        # 计算 top-1 acc（图像 -> 文本）
        _, pred = logits_per_image.softmax(dim=-1).max(dim=-1)
        correct += (pred == ground_truth).sum().item()
        total += len(images)

        total_loss += loss.item()
        pbar.set_postfix(loss=loss.item(), acc=f"{100*correct/total:.2f}%")

    # 保存模型
    torch.save({
        "epoch": epoch,
        "model_state_dict": model.state_dict(),
        "optimizer_state_dict": optimizer.state_dict()
    }, f"finetuned_clip_epoch{epoch+1}.pt")

    print(f"✅ Epoch {epoch+1} done. Loss: {total_loss/len(train_loader):.4f}, Acc: {100*correct/total:.2f}%")

    # 验证阶段
    accs = evaluate(model, val_dataset)
    val_top1_list.append(accs["top1"])
    val_top5_list.append(accs["top5"])

    print(f"📊 Validation top1: {accs['top1']*100:.2f}%, top5: {accs['top5']*100:.2f}%")

# === 绘图 ===
plt.plot(range(1, NUM_EPOCHS + 1), [a * 100 for a in val_top1_list], label='Top-1 Accuracy')
plt.plot(range(1, NUM_EPOCHS + 1), [a * 100 for a in val_top5_list], label='Top-5 Accuracy')
plt.xlabel('Epoch')
plt.ylabel('Accuracy (%)')
plt.title('Validation Accuracy over Epochs')
plt.legend()
plt.grid()
plt.savefig("val_accuracy.png")
plt.show()

# 设备配置
device = "cuda" if torch.cuda.is_available() else "cpu"

# 加载模型和预处理器
model, preprocess = clip.load("ViT-B/32", device=device)

checkpoint = torch.load("finetuned_clip_epoch2.pt")
model.load_state_dict(checkpoint['model_state_dict'])

# 加载模型和预处理器
raw_model, raw_preprocess = clip.load("ViT-B/32", device=device)

accs = evaluate(raw_model, test_dataset)
print("微调前topk准确率为：", accs)

accs = evaluate(raw_model, test_dataset)
print("微调前topk准确率为：", accs)
