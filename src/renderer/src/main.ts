import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './routers';
import './style.css';

createApp(App).use(createPinia()).use(router).mount('#app');
