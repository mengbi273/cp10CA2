<template>
  <el-container class="layout-container">
    <el-header>
      <div class="header-content">
        <h1>图片云存储</h1>
        <el-dropdown @command="handleCommand">
          <span class="user-dropdown">
            {{ username }}
            <el-icon><arrow-down /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </el-header>
    
    <el-container>
      <el-aside width="200px">
        <el-menu
          :router="true"
          :default-active="$route.path"
        >
          <el-menu-item index="/dashboard/gallery">
            <el-icon><Folder /></el-icon>
            <span>我的图片</span>
          </el-menu-item>
          <el-menu-item index="/dashboard/clip-search">
            <el-icon><Search /></el-icon>
            <span>CLIP 搜索</span>
          </el-menu-item>
          <el-menu-item index="/dashboard/model-training">
            <el-icon><SetUp /></el-icon>
            <span>模型微调</span>
          </el-menu-item>
        </el-menu>
      </el-aside>
      <el-main>
        <router-view></router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowDown, Folder, Search, SetUp } from '@element-plus/icons-vue'

const router = useRouter()
const username = ref(localStorage.getItem('username') || '用户')

const handleCommand = (command) => {
  if (command === 'logout') {
    localStorage.removeItem('token')
    localStorage.removeItem('username')
    router.push('/login')
  }
}
</script>

<style scoped>
.layout-container {
  height: 100vh;
}

.el-header {
  background-color: #fff;
  border-bottom: 1px solid #dcdfe6;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
}

.user-dropdown {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

.el-aside {
  background-color: #fff;
  border-right: 1px solid #dcdfe6;
}

.el-menu {
  border-right: none;
}
</style>