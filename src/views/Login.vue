<template>
  <div class="login-container">
    <el-card class="login-card">
      <template #header>
        <h2>{{ isLogin ? '登录' : '注册' }}</h2>
      </template>
      
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="80px"
      >
        <el-form-item label="用户名" prop="username">
          <el-input 
            v-model="form.username"
            placeholder="请输入用户名"
          />
        </el-form-item>
        
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            show-password
          />
        </el-form-item>
        
        <el-form-item>
          <el-button type="primary" @click="handleSubmit" :loading="loading">
            {{ isLogin ? '登录' : '注册' }}
          </el-button>
          <el-button type="text" @click="toggleMode">
            {{ isLogin ? '没有账号？去注册' : '已有账号？去登录' }}
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import axios from 'axios'
import CryptoJS from 'crypto-js'

const router = useRouter()
const formRef = ref(null)
const loading = ref(false)
const isLogin = ref(true)

const form = ref({
  username: '',
  password: ''
})

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' }
  ]
}

const toggleMode = () => {
  isLogin.value = !isLogin.value
  form.value.username = ''
  form.value.password = ''
}

const encryptPassword = (password) => {
  const secretKey = 'your-secure-key-2024'
  return CryptoJS.AES.encrypt(password, secretKey).toString()
}

const handleSubmit = async () => {
  if (!formRef.value) return

  try {
    await formRef.value.validate()
    
    loading.value = true
    const url = isLogin.value ? 
      'http://57.181.23.46/api/auth/login' : 
      'http://57.181.23.46/api/auth/register'
    
    const encryptedPassword = encryptPassword(form.value.password)
    
    const response = await axios.post(url, {
      username: form.value.username,
      password: encryptedPassword,
      isEncrypted: true
    })

    const { token, username } = response.data
    localStorage.setItem('token', token)
    localStorage.setItem('username', username)
    
    ElMessage.success(isLogin.value ? '登录成功' : '注册成功')
    router.push('/dashboard/gallery')
  } catch (error) {
    if (error.response) {
      ElMessage.error(error.response.data.error || (isLogin.value ? '登录失败' : '注册失败'))
    } else if (error.message) {
      ElMessage.error(error.message)
    } else {
      ElMessage.error('表单验证失败')
    }
  } finally {
    loading.value = false
  }
}
</script>

<script>
export default {
  name: 'LoginView'
}
</script>

<style scoped>
.login-container {
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #f5f7fa;
}

.login-card {
  width: 400px;
}

.el-button + .el-button {
  margin-left: 10px;
}
</style> 