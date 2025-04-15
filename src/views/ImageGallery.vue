<template>
  <div class="gallery-container">
    <!-- 顶部操作栏 -->
    <div class="operation-bar">
      <div class="left-operations">
        <div v-if="selectedItems.length > 0" class="batch-operations">
          <el-button type="danger" @click="handleBatchDelete">
            删除选中项({{ selectedItems.length }})
          </el-button>
          <el-button type="warning" @click="openBatchMoveDialog">
            移动选中项({{ selectedItems.length }})
          </el-button>
        </div>
        <el-upload
          class="upload-button"
          :action="uploadUrl"
          :headers="uploadHeaders"
          :data="uploadData"
          :on-success="handleUploadSuccess"
          :on-error="handleUploadError"
          :before-upload="beforeUpload"
          :on-progress="handleUploadProgress"
          :on-exceed="handleExceed"
          multiple
          :limit="100"
          accept="image/*"
          name="images"
        >
          <el-button type="primary">
            <el-icon><Upload /></el-icon>上传图片
          </el-button>
        </el-upload>
        
        <el-button @click="showNewFolderDialog = true">
          <el-icon><FolderAdd /></el-icon>新建文件夹
        </el-button>

        <!-- 全选按钮 -->
        <el-button 
          v-if="images.length > 0"
          type="primary" 
          plain
          @click="toggleSelectAll"
        >
          {{ isAllSelected ? '取消全选' : `全选(${images.length})` }}
        </el-button>
      </div>
      
    </div>

    <!-- 面包屑导航 -->
    <el-breadcrumb separator="/" class="breadcrumb">
      <el-breadcrumb-item @click="navigateToRoot">全部图片</el-breadcrumb-item>
      <el-breadcrumb-item 
        v-for="folder in folderPath" 
        :key="folder.id"
        @click="navigateToFolder(folder)"
      >
        {{ folder.name }}
      </el-breadcrumb-item>
    </el-breadcrumb>

    <!-- 文件夹列表 -->
    <div v-if="folders.length > 0" class="folder-grid">
      <div v-for="folder in folders" :key="folder.id" class="folder-item" @click="handleFolderClick(folder, $event)" :class="{ 'selected': selectedItems.includes(folder.id) }">
        <el-checkbox
          v-model="folder.selected"
          @change="(val) => handleItemSelect(val, 'folder', folder.id)"
          @click.stop
        />
        <el-icon><Folder /></el-icon>
        <span class="folder-name" @dblclick.stop="startRename(folder)">
          <template v-if="!folder.isRenaming">
            {{ folder.name }}
          </template>
          <el-input
            v-else
            v-model="folder.newName"
            size="small"
            @blur="finishRename(folder)"
            @keyup.enter="finishRename(folder)"
            @keyup.esc="cancelRename(folder)"
            v-focus
            @click.stop
          />
        </span>
        <el-button 
          type="danger" 
          size="small"
          class="delete-btn"
          @click.stop="handleDeleteFolder(folder)"
        >
          <el-icon><Delete /></el-icon>
        </el-button>
        <el-button 
          type="primary" 
          size="small"
          class="rename-btn"
          @click.stop="startRename(folder)"
        >
          <el-icon><Edit /></el-icon>
        </el-button>
        <el-button 
          type="warning" 
          size="small"
          class="move-btn"
          @click.stop="openMoveDialog('folder', folder.id)"
        >
          <el-icon><Position /></el-icon>
        </el-button>
      </div>
    </div>

    <!-- 图片网格 -->
    <div v-if="images.length > 0" class="image-grid">
      <div v-for="image in images" :key="image.id" class="image-item" :class="{ 'selected': selectedItems.includes(image.id) }">
        <div class="image-select">
          <el-checkbox
            v-model="image.selected"
            @change="(val) => handleItemSelect(val, 'image', image.id)"
            @click.stop
          />
        </div>
        <div class="image-container">
          <el-image 
            :src="image.url" 
            fit="cover"
            :preview-src-list="[image.url]"
            loading="lazy"
          >
            <template #error>
              <div class="image-error">
                <el-icon><Picture /></el-icon>
                <span>加载失败</span>
              </div>
            </template>
          </el-image>
        </div>
        <div class="image-info">
          <span class="image-name">{{ image.name }}</span>
          <el-button 
            type="danger" 
            size="small" 
            @click="handleDelete(image)"
            :loading="image.deleting"
          >
            <el-icon><Delete /></el-icon>
          </el-button>
          <el-button 
            type="warning" 
            size="small"
            @click="openMoveDialog('image', image.id)"
          >
            <el-icon><Position /></el-icon>
          </el-button>
        </div>
      </div>
    </div>

    <div v-else class="empty-state">
      <el-empty description="还没有上传任何图片" />
    </div>

    <!-- 新建文件夹对话框 -->
    <el-dialog
      v-model="showNewFolderDialog"
      title="新建文件夹"
      width="30%"
    >
      <el-form :model="newFolder" :rules="folderRules" ref="folderFormRef">
        <el-form-item prop="name" label="文件夹名称">
          <el-input v-model="newFolder.name" placeholder="请输入文件夹名称" />
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="showNewFolderDialog = false">取消</el-button>
          <el-button type="primary" @click="createFolder" :loading="creating">
            确定
          </el-button>
        </span>
      </template>
    </el-dialog>

    <!-- 移动对话框 -->
    <el-dialog
      v-model="showMoveDialog"
      :title="moveDialogTitle"
      width="30%"
    >
      <el-tree
        ref="folderTree"
        :data="folderTreeData"
        node-key="id"
        :props="{
          label: 'name',
          children: 'children'
        }"
        :default-expanded-keys="[rootFolderId]"
        @node-click="handleFolderSelect"
        highlight-current
      />
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="showMoveDialog = false">取消</el-button>
          <el-button type="primary" @click="confirmMove" :loading="moving">
            确定
          </el-button>
        </span>
      </template>
    </el-dialog>

    <!-- 批量移动对话框 -->
    <el-dialog
      v-model="showBatchMoveDialog"
      title="批量移动到..."
      width="30%"
    >
      <el-tree
        ref="folderTree"
        :data="folderTreeData"
        node-key="id"
        :props="{
          label: 'name',
          children: 'children'
        }"
        :default-expanded-keys="[rootFolderId]"
        @node-click="handleFolderSelect"
        highlight-current
      />
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="showBatchMoveDialog = false">取消</el-button>
          <el-button type="primary" @click="confirmBatchMove" :loading="moving">
            确定
          </el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Upload, Delete, Picture, FolderAdd, Folder, Edit, Position } from '@element-plus/icons-vue'
import axios from 'axios'

// 状态
const images = ref([])
const uploadUrl = 'http://57.181.23.46/api/images/upload'
const uploadHeaders = {
  Authorization: `Bearer ${localStorage.getItem('token')}`
}
const currentFolderId = ref(null)
const rootFolderId = ref(null)
const folderPath = ref([])
const folders = ref([])
const showNewFolderDialog = ref(false)
const creating = ref(false)
const folderFormRef = ref(null)
const newFolder = ref({
  name: ''
})
const showMoveDialog = ref(false)
const moving = ref(false)
const selectedFolderId = ref(null)
const moveType = ref('')  // 'folder' 或 'image'
const moveItemId = ref(null)
const folderTreeData = ref([])
const selectedItems = ref([])
const showBatchMoveDialog = ref(false)

const folderRules = {
  name: [
    { required: true, message: '请输入文件夹名称', trigger: 'blur' },
    { min: 1, max: 50, message: '长度在 1 到 50 个字符', trigger: 'blur' }
  ]
}

// 计算上传数据
const uploadData = computed(() => ({
  folder_id: currentFolderId.value === null ? '' : currentFolderId.value
}))

// 计算移动对话框标题
const moveDialogTitle = computed(() => {
  return `移动${moveType.value === 'folder' ? '文件夹' : '图片'}到...`
})


// 计算属性：是否全部选中
const isAllSelected = computed(() => {
  return images.value.length > 0 && selectedItems.value.length === images.value.filter(image => !image.folder).length
})

// 全选/取消全选方法
const toggleSelectAll = () => {
  if (isAllSelected.value) {
    // 取消全选
    selectedItems.value = []
    images.value.forEach(image => image.selected = false)
  } else {
    // 全选当前文件夹下的图片
    selectedItems.value = images.value.map(image => {
      image.selected = true
      return image.id
    })
  }
}

// 获取图片列表
const fetchImages = async () => {
  try {
    const response = await axios.get('http://57.181.23.46/api/images', {
      headers: uploadHeaders,
      params: {
        folder_id: currentFolderId.value
      }
    })
    images.value = response.data
  } catch (error) {
    ElMessage.error('获取图片列表失败')
  }
}

// 获取文件夹列表
const fetchFolders = async () => {
  try {
    const response = await axios.get('http://57.181.23.46/api/folders', {
      headers: uploadHeaders,
      params: { parent_id: currentFolderId.value }
    })
    console.log('获取到的文件夹列表:', response.data)
    folders.value = response.data
    // 如果是首次加载，保存根文件夹ID
    if (!currentFolderId.value && !rootFolderId.value) {
      const rootResponse = await axios.get('http://57.181.23.46/api/folders', {
        headers: uploadHeaders,
        params: { is_root: true }
      })
      if (rootResponse.data.length > 0) {
        rootFolderId.value = rootResponse.data[0].id
      }
    }
  } catch (error) {
    console.error('获取文件夹列表错误:', error)
    ElMessage.error('获取文件夹列表失败')
  }
}

// 获取文件夹树数据
const fetchFolderTree = async () => {
  try {
    const response = await axios.get('http://57.181.23.46/api/folders', {
      headers: uploadHeaders,
      params: { tree: true }
    })
    folderTreeData.value = response.data
  } catch (error) {
    console.error('获取文件夹树错误:', error)
    ElMessage.error('获取文件夹列表失败')
  }
}

// 上传相关方法
const beforeUpload = (file) => {
  const isImage = file.type.startsWith('image/')
  const isLt5M = file.size / 1024 / 1024 < 5

  if (!isImage) {
    ElMessage.error('只能上传图片文件！')
    return false
  }
  if (!isLt5M) {
    ElMessage.error('图片大小不能超过 5MB！')
    return false
  }
  return true
}

const handleUploadSuccess = (response, file, fileList) => {
  console.log('上传成功:', response, file, fileList)
  ElMessage.success(`成功上传 ${response.count} 张图片`)
  fetchImages()
  // 延迟2秒后清除该文件的上传记录
  setTimeout(() => {
    const uploadRef = document.querySelector('.el-upload-list')
    if (uploadRef) {
      const successItems = uploadRef.querySelectorAll('.el-upload-list__item-status-label')
      successItems.forEach(item => {
        const listItem = item.closest('.el-upload-list__item')
        if (listItem) {
          listItem.style.opacity = '0'
          setTimeout(() => {
            listItem.remove()
          }, 300) // 添加淡出动画
        }
      })
    }
  }, 2000)
}

const handleUploadError = (error, file, fileList) => {
  console.error('上传错误:', error, file)
  const errorMsg = error.response?.data?.error || error.message || '上传失败'
  ElMessage.error(`文件 ${file.name} 上传失败: ${errorMsg}`)
}

const handleUploadProgress = (event, file, fileList) => {
  console.log('上传进度:', event.percent, file.name)
}

const handleExceed = (files, uploadFiles) => {
  ElMessage.warning(
    `最多可以上传100个文件，本次选择了 ${files.length} 个文件，已有 ${uploadFiles.length} 个文件`
  )
}

// 删除图片
const handleDelete = async (image) => {
  try {
    await ElMessageBox.confirm('确定要删除这张图片吗？', '提示', {
      type: 'warning'
    })

    image.deleting = true
    await axios.delete(`http://57.181.23.46/api/images/${image.id}`, {
      headers: uploadHeaders
    })
    
    ElMessage.success('删除成功')
    images.value = images.value.filter(img => img.id !== image.id)
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败')
    }
  } finally {
    image.deleting = false
  }
}

// 文件夹相关方法
const createFolder = async () => {
  if (!folderFormRef.value) return
  
  try {
    await folderFormRef.value.validate()
    creating.value = true
    
    await axios.post('http://57.181.23.46/api/folders', {
      name: newFolder.value.name,
      parent_id: currentFolderId.value
    }, {
      headers: uploadHeaders
    })

    ElMessage.success('文件夹创建成功')
    showNewFolderDialog.value = false
    newFolder.value.name = ''
    await fetchFolders()
  } catch (error) {
    console.error('创建文件夹错误:', error)
    if (error.response?.data?.error) {
      ElMessage.error(error.response.data.error)
    } else {
      ElMessage.error('创建文件夹失败')
    }
  } finally {
    creating.value = false
  }
}

const handleDeleteFolder = async (folder) => {
  try {
    await ElMessageBox.confirm('确定要删除这个文件夹吗？文件夹内的所有内容都会被删除！', '警告', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消'
    })

    await axios.delete(`http://57.181.23.46/api/folders/${folder.id}`, {
      headers: uploadHeaders
    })

    ElMessage.success('文件夹删除成功')
    fetchFolders()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除文件夹失败')
    }
  }
}

const navigateToRoot = () => {
  currentFolderId.value = null
  folderPath.value = []
  fetchFolders()
  fetchImages()
}

const navigateToFolder = (folder) => {
  const index = folderPath.value.findIndex(f => f.id === folder.id)
  folderPath.value = folderPath.value.slice(0, index + 1)
  currentFolderId.value = folder.id
  fetchFolders()
  fetchImages()
}

const enterFolder = (folder) => {
  folderPath.value.push(folder)
  currentFolderId.value = folder.id
  fetchFolders()
  fetchImages()
}

// 添加自定义指令
const vFocus = {
  mounted: (el) => el.querySelector('input').focus()
}

// 添加重命名相关方法
const startRename = (folder) => {
  folder.isRenaming = true
  folder.newName = folder.name
}

const cancelRename = (folder) => {
  folder.isRenaming = false
  folder.newName = folder.name
}

const finishRename = async (folder) => {
  try {
    if (!folder.newName || folder.newName === folder.name) {
      cancelRename(folder)
      return
    }

    const response = await axios.put(
      `http://57.181.23.46/api/folders/${folder.id}/rename`,
      { name: folder.newName },
      { headers: uploadHeaders }
    )

    folder.name = folder.newName
    folder.isRenaming = false
    ElMessage.success('重命名成功')
  } catch (error) {
    console.error('重命名错误:', error)
    ElMessage.error(error.response?.data?.error || '重命名失败')
    cancelRename(folder)
  }
}

// 处理文件夹选择
const handleFolderSelect = (folder) => {
  selectedFolderId.value = folder.id
}

// 打开移动对话框
const openMoveDialog = async (type, id) => {
  moveType.value = type
  moveItemId.value = id
  selectedFolderId.value = null
  showMoveDialog.value = true
  try {
    await fetchFolderTree()
  } catch (error) {
    console.error('获取文件夹树错误:', error)
    ElMessage.error('获取文件夹列表失败')
    showMoveDialog.value = false
  }
}

// 确认移动
const confirmMove = async () => {
  if (!selectedFolderId.value) {
    ElMessage.warning('请选择目标文件夹')
    return
  }

  try {
    moving.value = true
    const url = moveType.value === 'folder' 
      ? `http://57.181.23.46/api/folders/${moveItemId.value}/move`
      : `http://57.181.23.46/api/images/${moveItemId.value}/move`

    await axios.put(url, 
      { target_folder_id: selectedFolderId.value },
      { headers: uploadHeaders }
    )

    ElMessage.success('移动成功')
    showMoveDialog.value = false
    fetchFolders()
    fetchImages()
  } catch (error) {
    console.error('移动错误:', error)
    ElMessage.error(error.response?.data?.error || '移动失败')
  } finally {
    moving.value = false
  }
}

// 添加选择相关方法
const handleItemSelect = (selected, type, id) => {
  if (selected) {
    selectedItems.value.push(id)
  } else {
    selectedItems.value = selectedItems.value.filter(item => item !== id)
  }
}

const handleFolderClick = (folder, event) => {
  if (event.ctrlKey || event.metaKey) {
    folder.selected = !folder.selected
    handleItemSelect(folder.selected, 'folder', folder.id)
  } else {
    enterFolder(folder)
  }
}

// 批量删除
const handleBatchDelete = async () => {
  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedItems.value.length} 个项目吗？`,
      '警告',
      {
        type: 'warning',
        confirmButtonText: '确定',
        cancelButtonText: '取消'
      }
    )

    const deletePromises = selectedItems.value.map(id => {
      const isFolder = folders.value.find(f => f.id === id)
      const url = isFolder 
        ? `http://57.181.23.46/api/folders/${id}`
        : `http://57.181.23.46/api/images/${id}`
      return axios.delete(url, { headers: uploadHeaders })
    })

    await Promise.all(deletePromises)
    ElMessage.success('批量删除成功')
    selectedItems.value = []
    fetchFolders()
    fetchImages()
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量删除错误:', error)
      ElMessage.error('批量删除失败')
    }
  }
}

// 批量移动
const openBatchMoveDialog = async () => {
  showBatchMoveDialog.value = true
  try {
    await fetchFolderTree()
  } catch (error) {
    console.error('获取文件夹树错误:', error)
    ElMessage.error('获取文件夹列表失败')
    showBatchMoveDialog.value = false
  }
}

const confirmBatchMove = async () => {
  if (!selectedFolderId.value) {
    ElMessage.warning('请选择目标文件夹')
    return
  }

  try {
    moving.value = true
    const movePromises = selectedItems.value.map(id => {
      const isFolder = folders.value.find(f => f.id === id)
      const url = isFolder
        ? `http://57.181.23.46/api/folders/${id}/move`
        : `http://57.181.23.46/api/images/${id}/move`
      return axios.put(url, 
        { target_folder_id: selectedFolderId.value },
        { headers: uploadHeaders }
      )
    })

    await Promise.all(movePromises)
    ElMessage.success('批量移动成功')
    showBatchMoveDialog.value = false
    selectedItems.value = []
    fetchFolders()
    fetchImages()
  } catch (error) {
    console.error('批量移动错误:', error)
    ElMessage.error('批量移动失败')
  } finally {
    moving.value = false
  }
}

onMounted(() => {
  fetchFolders()
  fetchImages()
})
</script>

<script>
export default {
  name: 'ImageGalleryView'
}
</script>

<style scoped>
.gallery-container {
  padding: 20px;
}

.operation-bar {
  display: flex;
  justify-content: space-between;
  margin-bottom: 20px;
}

.left-operations {
  display: flex;
  gap: 10px;
}

.search-input {
  width: 300px;
}

.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

.image-item {
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 12px 0 rgba(0,0,0,0.1);
  position: relative;
}

.image-container {
  position: relative;
  width: 100%;
  height: 200px;
}

.image-item .el-image {
  width: 100%;
  height: 200px;
  display: block;
}

.image-info {
  padding: 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
}

.image-name {
  font-size: 14px;
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  margin-right: 10px;
}

.image-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #909399;
}

.empty-state {
  padding: 40px 0;
}

.el-upload__tip {
  font-size: 12px;
  color: #909399;
  margin-top: 7px;
}

/* 添加上传按钮的样式 */
:deep(.el-upload-list) {
  margin-top: 10px;
}

:deep(.el-upload-list__item) {
  transition: all 0.3s;
  opacity: 1;
}

:deep(.el-upload-list__item-status-label) {
  right: 5px;
  top: 5px;
}

/* 添加新的样式 */
.breadcrumb {
  margin-bottom: 20px;
}

.folder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
  margin-bottom: 20px;
}

.folder-item {
  display: flex;
  align-items: center;
  padding: 10px;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  position: relative;
  border: 1px solid #ebeef5;
}

.folder-item:hover {
  background: #f5f7fa;
}

.folder-item .el-icon {
  font-size: 20px;
  color: #909399;
  margin-right: 8px;
}

.folder-name {
  flex: 1;
  padding: 4px;
  border-radius: 4px;
  cursor: text;
}

.folder-name:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.delete-btn {
  opacity: 0;
  transition: opacity 0.3s;
}

.folder-item:hover .delete-btn {
  opacity: 1;
}

.rename-btn {
  opacity: 0;
  transition: opacity 0.3s;
  margin-left: 8px;
}

.folder-item:hover .rename-btn {
  opacity: 1;
}

.move-btn {
  opacity: 0;
  transition: opacity 0.3s;
  margin-left: 8px;
}

.folder-item:hover .move-btn {
  opacity: 1;
}

:deep(.el-input__inner) {
  height: 28px;
}

.batch-operations {
  display: flex;
  gap: 10px;
}

.folder-item.selected,
.image-item.selected {
  outline: 2px solid var(--el-color-primary);
}

.image-select {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 1;
  background-color: rgba(255, 255, 255, 0.9);
  border-radius: 4px;
  padding: 2px;
  transition: opacity 0.3s;
  opacity: 0;
}

.image-item:hover .image-select,
.image-item.selected .image-select {
  opacity: 1;
}

.folder-item .el-checkbox {
  margin-right: 8px;
}

/* 全选按钮样式 */
.operation-bar .el-button {
  margin-right: 10px;
}
</style> 