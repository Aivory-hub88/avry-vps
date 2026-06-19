import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useAuthStore } from './stores/auth';
import './styles/theme.css';

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// Validate session on startup before rendering protected routes
const authStore = useAuthStore();
authStore.checkSession().then(() => {
  app.mount('#app');
});
