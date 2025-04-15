<template>
  <main-layout>
    <router-view></router-view>
  </main-layout>
</template>

<script setup>
import MainLayout from '../layouts/MainLayout.vue'
</script>

<script>
export default {
  name: 'DashboardView'
}
</script>