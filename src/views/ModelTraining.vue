<template>
  <div class="model-training">
    <div class="page-header">
      <h2>CLIP 模型微调</h2>
      <p class="description">
        上传自定义数据集来微调 CLIP 模型，提高特定领域图片检索的准确性
      </p>
    </div>

    <!-- 数据集上传区域 -->
    <el-card class="upload-section">
      <template #header>
        <div class="card-header">
          <span>上传训练数据集</span>
        </div>
      </template>
      
      <el-form :model="trainingForm" label-position="top">
        <el-form-item label="数据集名称">
          <el-input 
            v-model="trainingForm.name" 
            placeholder="请输入数据集名称，例如：建筑数据集"
          />
        </el-form-item>
        
        <el-form-item label="数据集描述">
          <el-input 
            v-model="trainingForm.description" 
            type="textarea" 
            placeholder="请描述这个数据集的内容和用途"
          />
        </el-form-item>
        
        <!-- 上传zip文件 -->
        <el-form-item label="上传数据集压缩包">
          <el-upload
            ref="uploadRef"
            action="#"
            :auto-upload="false"
            :on-change="handleZipFileChange"
            :on-remove="handleZipFileRemove"
            :limit="1"
            accept=".zip"
            :file-list="zipFileList"
            :before-upload="() => false"
            class="upload-component"
            :http-request="customUpload"
          >
            <el-button type="primary">选择文件</el-button>
            <template #tip>
              <div class="el-upload__tip">
                <p>请上传包含训练数据的ZIP压缩文件（大小不超过1GB），压缩包内应包含:</p>
                <ul>
                  <li>images文件夹：存放所有图片文件</li>
                  <li>annotations.json文件：包含图片标注数据</li>
                </ul>
                <p>JSON格式示例：</p>
                <pre>{
  "images": [
    {
      "image_path": "images/product1.jpg",
      "product_title": "产品描述文本"
    },
    ...
  ]
}</pre>
              </div>
            </template>
          </el-upload>
        </el-form-item>
        
        <div class="form-actions">
          <el-button 
            type="primary" 
            @click="submitTrainingData" 
            :loading="uploading"
          >
            上传训练数据
          </el-button>
        </div>
      </el-form>
    </el-card>

    <!-- 已上传的数据集列表 -->
    <el-card class="dataset-list" v-if="datasets.length > 0">
      <template #header>
        <div class="card-header">
          <span>我的数据集</span>
          <el-button type="primary" @click="refreshDatasets" size="small">
            <el-icon><Refresh /></el-icon> 刷新
          </el-button>
        </div>
      </template>
      
      <el-table :data="datasets" style="width: 100%">
        <el-table-column prop="name" label="数据集名称" />
        <el-table-column prop="description" label="描述" show-overflow-tooltip />
        <el-table-column prop="imageCount" label="图片数量" width="100" />
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="scope">
            <el-tag :type="getStatusType(scope.row.status)">
              {{ getStatusText(scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="scope">
            <el-button 
              type="primary" 
              size="small" 
              @click="startTraining(scope.row.id)"
              :disabled="scope.row.status !== 'ready'"
            >
              开始训练
            </el-button>
            <el-button 
              type="danger" 
              size="small" 
              @click="deleteDataset(scope.row.id)"
              :disabled="scope.row.status === 'training'"
            >
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 模型列表 -->
    <el-card class="model-list" v-if="models.length > 0">
      <template #header>
        <div class="card-header">
          <span>已训练的模型</span>
          <el-button type="primary" @click="refreshModels" size="small">
            <el-icon><Refresh /></el-icon> 刷新
          </el-button>
        </div>
      </template>
      
      <el-table :data="models" style="width: 100%">
        <el-table-column prop="name" label="模型名称" />
        <el-table-column prop="basedOn" label="基于数据集" />
        <el-table-column prop="createdAt" label="创建时间" width="180" />
        <el-table-column prop="status" label="状态" width="120">
          <template #default="scope">
            <el-tag :type="getModelStatusType(scope.row.status)">
              {{ getModelStatusText(scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300">
          <template #default="scope">
            <el-button 
              type="success" 
              size="small" 
              @click="deployModel(scope.row.id)"
              :disabled="scope.row.status !== 'ready'"
            >
              部署
            </el-button>
            <el-button 
              type="info" 
              size="small" 
              @click="undeployModel(scope.row.id)"
              :disabled="scope.row.status !== 'deployed'"
            >
              取消部署
            </el-button>
            <el-button 
              type="danger" 
              size="small" 
              @click="deleteModel(scope.row.id)"
              :disabled="['training', 'deploying'].includes(scope.row.status)"
            >
              删除
            </el-button>
            <el-button 
              type="warning" 
              size="small" 
              @click="forceDeleteModel(scope.row.id)"
              v-if="['training', 'deploying', 'error'].includes(scope.row.status)"
            >
              强制删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import axios from 'axios'

// 配置 axios 拦截器处理错误
axios.interceptors.response.use(
  response => response,
  error => {
    console.error('请求错误:', error);
    if (error.response) {
      // 服务器返回了错误状态码
      console.error('服务器响应:', error.response.data);
    } else if (error.request) {
      // 请求已发送但没有收到响应
      console.error('未收到响应，可能是网络问题或服务器未运行');
      ElMessage.error('网络错误，请检查服务器是否运行');
    } else {
      // 请求配置出错
      console.error('请求配置错误:', error.message);
    }
    return Promise.reject(error);
  }
);

// 训练表单数据
const trainingForm = ref({
  name: '',
  description: ''
})

// 上传状态
const uploading = ref(false)
const uploadRef = ref(null)
const zipFileList = ref([])
const datasetFile = ref(null)  // 新增直接存储文件的变量

// 数据集和模型
const datasets = ref([])
const models = ref([])

// 使用训练参数
const trainingParams = ref({
  epochs: 3,
  batchSize: 32,
  learningRate: 0.0001
})

// 生命周期钩子
onMounted(() => {
  refreshDatasets()
  refreshModels()
  
  // 添加全局 ResizeObserver 错误处理
  window.addEventListener('error', (event) => {
    if (event.message.includes('ResizeObserver')) {
      // 防止 ResizeObserver 错误显示
      event.stopImmediatePropagation();
    }
  });
})

// 处理ZIP文件变更
const handleZipFileChange = (file) => {
  console.log('文件变更:', file)
  datasetFile.value = file.raw  // 直接存储文件对象
  
  // 文件类型验证
  if (file.raw.type !== 'application/zip' && !file.name.endsWith('.zip')) {
    ElMessage.error('只能上传ZIP压缩文件！')
    zipFileList.value = []
    datasetFile.value = null
    return false
  }
  
  // 文件大小验证（1GB）
  if (file.raw.size / 1024 / 1024 > 1024) {
    ElMessage.error('文件大小不能超过1GB！')
    zipFileList.value = []
    datasetFile.value = null
    return false
  }
  
  // 确保文件被添加到列表中
  console.log('文件通过验证，添加到列表')
  zipFileList.value = [file]
  console.log('当前文件列表:', zipFileList.value)
  
  return true
}

// 处理ZIP文件移除
const handleZipFileRemove = () => {
  try {
    // 使用 nextTick 延迟清除操作，避免 DOM 操作冲突
    nextTick(() => {
      zipFileList.value = [];
      datasetFile.value = null;
      console.log('文件已移除');
    });
  } catch (error) {
    console.error('文件移除错误:', error);
    ElMessage.error('文件移除过程中发生错误');
  }
}

// 自定义上传方法，防止自动上传
const customUpload = () => {
  // 阻止默认上传行为
  return false;
}

// 上传训练数据
const submitTrainingData = async () => {
  // 表单验证
  if (!trainingForm.value.name) {
    ElMessage.warning('请输入数据集名称')
    return
  }
  
  console.log('提交前的文件列表:', zipFileList.value)
  console.log('提交前的文件对象:', datasetFile.value)
  
  // 检查是否有文件上传
  if (!datasetFile.value) {
    ElMessage.warning('请上传数据集压缩包')
    return
  }

  try {
    uploading.value = true
    
    // 创建FormData对象
    const formData = new FormData()
    formData.append('name', trainingForm.value.name)
    formData.append('description', trainingForm.value.description)
    
    // 添加ZIP文件
    formData.append('zipFile', datasetFile.value)
    
    // 发送请求
    await axios.post(
      'http://57.181.23.46/api/training/upload-dataset',
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('数据集上传成功！')
    
    // 使用 nextTick 延迟重置表单，避免 DOM 操作冲突
    nextTick(() => {
      // 重置表单
      trainingForm.value.name = ''
      trainingForm.value.description = ''
      zipFileList.value = []
      datasetFile.value = null
      if (uploadRef.value) {
        uploadRef.value.clearFiles()
      }
      
      // 刷新数据集列表
      refreshDatasets()
    });
    
  } catch (error) {
    console.error('上传数据集错误:', error)
    ElMessage.error(error.response?.data?.error || '上传失败，请重试')
  } finally {
    uploading.value = false
  }
}

// 刷新数据集列表
const refreshDatasets = async () => {
  try {
    const response = await axios.get(
      'http://57.181.23.46/api/training/datasets',
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    datasets.value = response.data
  } catch (error) {
    console.error('获取数据集列表错误:', error)
    ElMessage.error('获取数据集列表失败')
  }
}

// 刷新模型列表
const refreshModels = async () => {
  try {
    const response = await axios.get(
      'http://57.181.23.46/api/training/models',
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    models.value = response.data
  } catch (error) {
    console.error('获取模型列表错误:', error)
    ElMessage.error('获取模型列表失败')
  }
}

// 开始训练模型
const startTraining = async (datasetId) => {
  try {
    await ElMessageBox.confirm(
      '开始训练模型可能需要较长时间，期间无法取消。确定要继续吗？',
      '确认训练',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await axios.post(
      'http://57.181.23.46/api/training/start',
      { 
        datasetId,
        modelName: `模型-${new Date().toISOString().split('T')[0]}`,
        epochs: trainingParams.value.epochs,
        batchSize: trainingParams.value.batchSize,
        learningRate: trainingParams.value.learningRate
      },
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('模型训练任务已提交！')
    refreshDatasets()
    refreshModels()
    
  } catch (error) {
    if (error !== 'cancel') {
      console.error('提交训练任务错误:', error)
      ElMessage.error(error.response?.data?.error || '提交训练任务失败')
    }
  }
}

// 删除数据集
const deleteDataset = async (datasetId) => {
  try {
    await ElMessageBox.confirm(
      '删除数据集将同时删除相关的训练数据，此操作不可恢复。确定要继续吗？',
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await axios.delete(
      `http://57.181.23.46/api/training/datasets/${datasetId}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('数据集已删除！')
    refreshDatasets()
    
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除数据集错误:', error)
      ElMessage.error('删除数据集失败')
    }
  }
}

// 修改部署模型函数
const deployModel = async (modelId) => {
  try {
    await ElMessageBox.confirm(
      '部署模型到AWS端点可能需要几分钟时间。部署后，模型将可用于图片检索。确定要继续吗？',
      '确认部署',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'info'
      }
    )
    
    await axios.post(
      'http://57.181.23.46/api/training/deploy',
      { modelId },
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('模型部署任务已提交！')
    refreshModels()
    
  } catch (error) {
    if (error !== 'cancel') {
      console.error('部署模型错误:', error)
      ElMessage.error(error.response?.data?.error || '部署模型失败')
    }
  }
}

// 取消部署模型
const undeployModel = async (modelId) => {
  try {
    await axios.post(
      'http://57.181.23.46/api/training/undeploy',
      { modelId },
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('模型已取消部署！')
    refreshModels()
    
  } catch (error) {
    console.error('取消部署模型错误:', error)
    ElMessage.error(error.response?.data?.error || '取消部署模型失败')
  }
}

// 删除模型
const deleteModel = async (modelId) => {
  try {
    await ElMessageBox.confirm(
      '删除模型将同时删除相关的训练数据，此操作不可恢复。确定要继续吗？',
      '确认删除',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
    
    await axios.delete(
      `http://57.181.23.46/api/training/models/${modelId}`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('模型已删除！')
    refreshModels()
    
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除模型错误:', error)
      ElMessage.error('删除模型失败')
    }
  }
}

// 强制删除模型
const forceDeleteModel = async (modelId) => {
  try {
    await ElMessageBox.confirm(
      '强制删除可能导致AWS资源无法正确清理，只在模型状态异常时使用。确定要继续吗？',
      '强制删除警告',
      {
        confirmButtonText: '确定强制删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger'
      }
    )
    
    await axios.delete(
      `http://57.181.23.46/api/training/models/${modelId}/force`,
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`
        }
      }
    )
    
    ElMessage.success('模型已强制删除！')
    refreshModels()
    
  } catch (error) {
    if (error !== 'cancel') {
      console.error('强制删除模型错误:', error)
      ElMessage.error(error.response?.data?.error || '强制删除模型失败')
    }
  }
}

// 获取状态标签类型
const getStatusType = (status) => {
  const types = {
    'ready': 'success',
    'uploading': 'warning',
    'training': 'primary',
    'error': 'danger'
  }
  return types[status] || 'info'
}

// 获取状态文本
const getStatusText = (status) => {
  const texts = {
    'ready': '就绪',
    'uploading': '上传中',
    'training': '训练中',
    'error': '错误'
  }
  return texts[status] || status
}

// 获取模型状态标签类型
const getModelStatusType = (status) => {
  const types = {
    'ready': 'success',
    'training': 'primary',
    'deploying': 'warning',
    'deployed': 'success',
    'error': 'danger'
  }
  return types[status] || 'info'
}

// 获取模型状态文本
const getModelStatusText = (status) => {
  const texts = {
    'ready': '就绪',
    'training': '训练中',
    'deploying': '部署中',
    'deployed': '已部署',
    'error': '错误'
  }
  return texts[status] || status
}
</script>

<style scoped>
.model-training {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 20px;
  text-align: center;
}

.description {
  color: #666;
  margin-top: 10px;
}

.upload-section, .dataset-list, .model-list {
  margin-bottom: 30px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.form-actions {
  display: flex;
  justify-content: center;
  margin-top: 20px;
}

.el-upload__tip {
  line-height: 1.5;
  margin-top: 5px;
}

.upload-component {
  width: 100%;
  display: block;
  margin-bottom: 20px;
}

/* 优化上传组件的样式 */
:deep(.el-upload-list) {
  width: 100%;
}

:deep(.el-upload-list__item) {
  transition: all 0.3s ease;
}
</style> 