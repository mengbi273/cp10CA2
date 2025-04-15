<template>
  <div class="clip-search">
    <div class="search-header">
      <h2>CLIP 智能图片搜索</h2>
      <p class="description">
        使用 CLIP 模型进行语义图片搜索，支持自然语言描述搜索图片
      </p>
    </div>

    <div class="folder-selection">
      <el-card class="folder-selection-card">
        <template #header>
          <div class="card-header">
            <span>选择搜索文件夹</span>
            <el-button v-if="selectedFolders.length > 0" type="text" @click="clearFolderSelection">
              清除选择
            </el-button>
          </div>
        </template>
        <el-tree
          :data="folderTree"
          node-key="id"
          show-checkbox
          check-strictly
          :props="{ label: 'name', children: 'children' }"
          :default-checked-keys="selectedFolders"
          @check="handleFolderChange"
        />
        <div class="selected-folders" v-if="selectedFolders.length > 0">
          <h4>已选择的文件夹:</h4>
          <el-tag
            v-for="folderId in selectedFolders"
            :key="folderId"
            class="selected-folder-tag"
            type="success"
            effect="light"
          >
            {{ getFolderNameById(folderId) }}
          </el-tag>
        </div>
      </el-card>
    </div>

    <!-- 模型选择 -->
    <div class="model-selection">
      <el-card>
        <template #header>
          <div class="card-header">
            <span>选择搜索模型</span>
          </div>
        </template>
        <el-radio-group v-model="selectedModelId" @change="handleModelChange">
          <el-radio 
            v-for="model in availableModels" 
            :key="model.id" 
            :label="model.id"
            :disabled="model.status === 'error'"
          >
            {{ model.name }}
            <el-tag v-if="model.is_default" type="success" effect="plain" size="small">默认</el-tag>
            <el-tag v-if="model.status === 'error'" type="danger" effect="plain" size="small">错误</el-tag>
          </el-radio>
        </el-radio-group>

        <div class="model-description" v-if="selectedModel">
          <p>{{ selectedModel.description || '使用选定模型进行图片检索' }}</p>
          <el-tag v-if="selectedModel.is_default" type="info" effect="light">标准CLIP模型</el-tag>
          <el-tag v-else type="warning" effect="light">微调模型</el-tag>
        </div>

        <div class="model-actions" v-if="!selectedModel?.is_default">
          <el-link type="primary" @click="goToModelTraining">
            管理微调模型 <el-icon><ArrowRight /></el-icon>
          </el-link>
        </div>
      </el-card>
    </div>

    <!-- 搜索历史和层级指示器 -->
    <div class="search-breadcrumb" v-if="isSecondarySearch">
      <el-breadcrumb separator="/">
        <el-breadcrumb-item @click="returnToPrimarySearch">
          <span>{{ primarySearchText }}</span>
        </el-breadcrumb-item>
        <el-breadcrumb-item>{{ searchText }}</el-breadcrumb-item>
      </el-breadcrumb>
    </div>

    <div class="search-box">
      <el-card>
        <template #header>
          <div class="card-header">
            <span>{{ isSecondarySearch ? '二次搜索' : '图片搜索' }}</span>
            <el-tooltip v-if="isSecondarySearch" content="返回到一次搜索结果" placement="top">
              <el-button type="primary" plain size="small" @click="returnToPrimarySearch">
                <el-icon><Back /></el-icon> 返回
              </el-button>
            </el-tooltip>
          </div>
        </template>
        
        <el-input
          v-model="searchText"
          placeholder="描述你想找的图片，例如：'一只橙色的猫'"
          :clearable="true"
          @keyup.enter="handleSearch"
        >
          <template #append>
            <el-button type="primary" @click="handleSearch" :loading="searching">
              搜索
            </el-button>
          </template>
        </el-input>

        <div class="search-examples" v-if="!isSecondarySearch">
          <p>搜索示例：</p>
          <el-tag
            v-for="example in searchExamples"
            :key="example"
            class="example-tag"
            @click="useExample(example)"
            effect="light"
          >
            {{ example }}
          </el-tag>
        </div>
      </el-card>
    </div>

    <!-- 二次搜索提示 -->
    <div class="secondary-search-tip" v-if="hasSearched && !isSecondarySearch && filteredResults.length > 0">
      <el-alert
        title="提示：您可以在这些结果的基础上进行二次搜索，获得更精确的结果"
        type="info"
        :closable="false"
        show-icon
      />
    </div>

    <div class="search-results" v-if="hasSearched">
      <template v-if="filteredResults.length > 0">
        <div class="results-header">
          <h3>
            搜索结果 ({{ filteredResults.length }})
          </h3>
          <el-button 
            v-if="!isSecondarySearch && filteredResults.length > 0" 
            type="success" 
            @click="startSecondarySearch"
          >
            在结果中二次搜索
          </el-button>
        </div>
        
        <div class="results-grid">
          <el-card
            v-for="result in filteredResults"
            :key="result.id"
            class="result-item"
            :body-style="{ padding: '0px' }"
            shadow="hover"
          >
            <el-image
              :src="result.url"
              fit="cover"
              :preview-src-list="[result.url]"
            >
              <template #error>
                <div class="image-error">
                  <el-icon><Picture /></el-icon>
                  <span>加载失败</span>
                </div>
              </template>
            </el-image>
            <div class="result-info">
              <span class="result-name">{{ result.name }}</span>
            </div>
          </el-card>
        </div>
      </template>
      <template v-else>
        <el-empty description="没有找到匹配的图片" />
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Picture, Back, ArrowRight } from '@element-plus/icons-vue'
import axios from 'axios'

// 搜索状态
const searchText = ref('')
const searching = ref(false)
const searchResults = ref([])
const hasSearched = ref(false)
const isSecondarySearch = ref(false)
const primarySearchText = ref('')
const primaryResults = ref([])
// 固定最小相似度阈值为15%，但在UI中不再显示
const minScoreThreshold = 0.155

// 文件夹选择
const folderTree = ref([])
const selectedFolders = ref([])

// 模型选择
const availableModels = ref([])
const selectedModelId = ref('1') // 默认选择标准CLIP模型
const selectedModel = computed(() => {
  return availableModels.value.find(model => model.id === selectedModelId.value) || null
})

// 搜索示例
const searchExamples = [
  '一只橙色的猫',
  '蓝天下的高山',
  '夕阳西下的海滩',
  '繁华的城市夜景',
  '鲜艳的花朵'
]

// 获取路由
const router = useRouter()

// 计算过滤后的结果
const filteredResults = computed(() => {
  if (!searchResults.value) return [];
  return searchResults.value;
});

// 文件夹相关方法
const fetchFolderTree = async () => {
  try {
    const response = await axios.get(
      'http://57.181.23.46/api/folders/tree',
      { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
    )
    folderTree.value = response.data
  } catch (error) {
    console.error('获取文件夹树错误:', error)
    ElMessage.error('获取文件夹失败')
  }
}

const handleFolderChange = (data, { checkedKeys }) => {
  selectedFolders.value = checkedKeys
}

// 清除文件夹选择
const clearFolderSelection = () => {
  selectedFolders.value = [];
  ElMessage.success('已清除文件夹选择');
}

const getFolderNameById = (id) => {
  const findFolder = (folders, id) => {
    for (const folder of folders) {
      if (folder.id === id) {
        return folder.name
      }
      if (folder.children) {
        const found = findFolder(folder.children, id)
        if (found) return found
      }
    }
    return null
  }
  return findFolder(folderTree.value, id) || `文件夹 ${id}`
}

// 搜索相关方法
const useExample = (example) => {
  searchText.value = example
  handleSearch()
}

// 获取可用的模型列表
const fetchAvailableModels = async () => {
  try {
    const response = await axios.get(
      'http://57.181.23.46:5000/api/clip/models',
      { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
    )
    availableModels.value = response.data

    // 如果返回结果为空，添加默认模型
    if (availableModels.value.length === 0) {
      availableModels.value = [
        {
          id: '1',
          name: 'CLIP默认模型',
          endpoint_name: null,
          description: '默认的CLIP ViT-L/14模型',
          is_default: true
        }
      ]
    }

    // 尝试从本地存储恢复上次选择的模型
    const lastSelectedModel = localStorage.getItem('selectedClipModel')
    if (lastSelectedModel) {
      // 确保该模型仍然可用
      const model = availableModels.value.find(m => m.id === lastSelectedModel)
      if (model) {
        selectedModelId.value = lastSelectedModel
      }
    }
  } catch (error) {
    console.error('获取可用模型错误:', error)
    ElMessage.error('获取模型列表失败，将使用默认模型')
    
    // 添加默认模型
    availableModels.value = [
      {
        id: '1',
        name: 'CLIP默认模型',
        endpoint_name: null,
        description: '默认的CLIP ViT-L/14模型',
        is_default: true
      }
    ]
  }
}

// 处理模型变更
const handleModelChange = (modelId) => {
  selectedModelId.value = modelId
  // 保存模型选择到本地存储
  localStorage.setItem('selectedClipModel', modelId)

  // 如果已经有搜索结果，询问是否使用新模型重新搜索
  if (hasSearched.value && searchResults.value.length > 0) {
    ElMessage({
      message: '模型已切换，再次搜索将使用新选择的模型',
      type: 'info'
    })
  }
}

// 导航到模型训练页面
const goToModelTraining = () => {
  router.push('/dashboard/model-training')
}

// 执行搜索
const handleSearch = async () => {
  // 验证搜索文本
  if (!searchText.value.trim()) {
    ElMessage.warning('请输入搜索内容')
    return
  }

  // 验证已选择的文件夹
  if (selectedFolders.value.length === 0) {
    ElMessage.warning('请至少选择一个文件夹进行搜索')
    return
  }

  searching.value = true

  try {
    // 获取所选文件夹中的所有图片路径
    const response = await axios.post(
      'http://57.181.23.46/api/folders/images',
      { folderIds: selectedFolders.value },
      { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
    )
    
    const imagePaths = response.data.map(item => item.path)
    
    if (imagePaths.length === 0) {
      ElMessage.warning('所选文件夹中没有图片')
      searching.value = false
      return
    }
    
    // 构建搜索请求数据
    const searchData = {
      query: searchText.value,
      images: imagePaths,
      min_score: minScoreThreshold
    }
    
    // 如果选择了非默认模型，添加端点名称
    if (selectedModel.value && !selectedModel.value.is_default) {
      searchData.endpoint_name = selectedModel.value.endpoint_name
    }
    
    console.log(`使用${selectedModel.value?.is_default ? '默认' : '微调'}模型搜索，${selectedModel.value?.is_default ? '' : `端点: ${selectedModel.value?.endpoint_name}`}`)
    
    // 发送到CLIP服务
    let searchResponse
    if (isSecondarySearch.value) {
      // 二次搜索逻辑
      searchData.primary_results = primaryResults.value
      searchResponse = await axios.post('http://57.181.23.46:5000/api/clip/secondary_search', searchData)
    } else {
      // 一次搜索逻辑
      searchResponse = await axios.post('http://57.181.23.46:5000/api/clip/search', searchData)
    }
    
    // 根据路径获取图片元数据
    const metadataResponse = await axios.post(
      'http://57.181.23.46/api/images/metadata',
      { paths: searchResponse.data.map(item => item.path) },
      { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } }
    )
    
    // 合并检索结果与元数据
    const detailedResults = searchResponse.data.map(result => {
      const metadata = metadataResponse.data.find(meta => meta.path === result.path) || {}
      return {
        ...result,
        id: metadata.id || null,
        name: metadata.name || result.path.split('/').pop().split('\\').pop(),
        metadata: metadata,
        url: metadata.url || `http://57.181.23.46/${result.path.replace(/\\/g, '/')}`
      }
    })
    
    searchResults.value = detailedResults
    hasSearched.value = true
    
    // 如果这是一次搜索，保存结果以便可能的二次搜索
    if (!isSecondarySearch.value) {
      primaryResults.value = searchResponse.data
      primarySearchText.value = searchText.value
    }
    
  } catch (error) {
    console.error('CLIP搜索错误:', error)
    ElMessage.error('搜索失败，请重试')
  } finally {
    searching.value = false
  }
}

// 开始二次搜索
const startSecondarySearch = () => {
  primaryResults.value = filteredResults.value;
  primarySearchText.value = searchText.value;
  searchText.value = '';
  isSecondarySearch.value = true;
}

// 返回到一次搜索结果
const returnToPrimarySearch = () => {
  searchResults.value = primaryResults.value;
  searchText.value = primarySearchText.value;
  isSecondarySearch.value = false;
}

// 初始化
onMounted(() => {
  fetchFolderTree()
  fetchAvailableModels()
})
</script>

<style scoped>
.clip-search {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.search-header {
  text-align: center;
  margin-bottom: 30px;
}

.description {
  color: #666;
  margin-top: 10px;
}

.folder-selection {
  margin-bottom: 20px;
}

.folder-selection-card, .search-box .el-card {
  margin-bottom: 20px;
  border-radius: 8px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.selected-folders {
  margin-top: 15px;
  border-top: 1px dashed #ebeef5;
  padding-top: 15px;
}

.selected-folder-tag {
  margin: 5px;
}

.search-breadcrumb {
  margin-bottom: 20px;
}

.search-breadcrumb .el-breadcrumb__item {
  cursor: pointer;
}

.search-box {
  max-width: 800px;
  margin: 0 auto 20px;
}

.search-examples {
  margin-top: 20px;
}

.example-tag {
  margin: 5px;
  cursor: pointer;
  transition: all 0.3s;
}

.example-tag:hover {
  background-color: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.secondary-search-tip {
  max-width: 800px;
  margin: 0 auto 20px;
}

.search-results {
  margin-top: 30px;
}

.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 25px;
  margin-top: 20px;
}

.result-item {
  transition: transform 0.3s;
  overflow: hidden;
}

.result-item:hover {
  transform: translateY(-5px);
}

.result-item .el-image {
  width: 100%;
  height: 220px;
  display: block;
}

.result-info {
  padding: 12px;
  background: #fff;
}

.result-name {
  display: block;
  font-size: 14px;
  color: #303133;
  font-weight: 500;
  margin-bottom: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #909399;
}

.model-selection {
  margin-bottom: 20px;
}

.model-description {
  margin-top: 15px;
  color: #666;
}

.model-actions {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}
</style>