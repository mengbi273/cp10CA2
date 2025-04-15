import { createRouter, createWebHistory } from 'vue-router'

import Login from '../views/Login.vue'

import Dashboard from '../views/Dashboard.vue'

import ImageGallery from '../views/ImageGallery.vue'

import ClipSearch from '../views/ClipSearch.vue'

import ModelTraining from '../views/ModelTraining.vue'



const routes = [

  {

    path: '/',

    redirect: '/login'

  },

  {

    path: '/login',

    name: 'Login',

    component: Login,

    meta: { requiresAuth: false }

  },

  {

    path: '/dashboard',

    name: 'Dashboard',

    component: Dashboard,

    meta: { requiresAuth: true },

    children: [

      {

        path: 'gallery',

        name: 'ImageGallery',

        component: ImageGallery

      },

      {

        path: 'clip-search',

        name: 'ClipSearch',

        component: ClipSearch

      },

      {

        path: 'model-training',

        name: 'ModelTraining',

        component: ModelTraining

      }

    ]

  }

]



const router = createRouter({

  history: createWebHistory(),

  routes

})



// 路由守卫

router.beforeEach((to, from, next) => {

  const token = localStorage.getItem('token')

  if (to.meta.requiresAuth && !token) {

    next('/login')

  } else {

    next()

  }

})



export default router 
