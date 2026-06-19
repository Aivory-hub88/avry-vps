import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
  },
  {
    path: '/containers',
    name: 'containers',
    component: () => import('@/views/ContainersView.vue'),
  },
  {
    path: '/projects',
    name: 'projects',
    component: () => import('@/views/ProjectsView.vue'),
  },
  {
    path: '/terminal',
    name: 'terminal',
    component: () => import('@/views/TerminalView.vue'),
  },
  {
    path: '/files',
    name: 'files',
    component: () => import('@/views/FilesView.vue'),
  },
  {
    path: '/domains',
    name: 'domains',
    component: () => import('@/views/DomainsView.vue'),
  },
  {
    path: '/ssl',
    name: 'ssl',
    component: () => import('@/views/SSLView.vue'),
  },
  {
    path: '/cron',
    name: 'cron',
    component: () => import('@/views/CronView.vue'),
  },
  {
    path: '/databases',
    name: 'databases',
    component: () => import('@/views/DatabasesView.vue'),
  },
  {
    path: '/backups',
    name: 'backups',
    component: () => import('@/views/BackupsView.vue'),
  },
  {
    path: '/jobs',
    name: 'jobs',
    component: () => import('@/views/JobsView.vue'),
  },
  {
    path: '/logs',
    name: 'logs',
    component: () => import('@/views/LogsView.vue'),
  },
  {
    path: '/alerts',
    name: 'alerts',
    component: () => import('@/views/AlertsView.vue'),
  },
  {
    path: '/audit-log',
    name: 'audit-log',
    component: () => import('@/views/AuditLogView.vue'),
  },
  {
    path: '/pipelines',
    name: 'pipelines',
    component: () => import('@/views/PipelinesView.vue'),
  },
  {
    path: '/webhooks',
    name: 'webhooks',
    component: () => import('@/views/WebhooksView.vue'),
  },
  {
    path: '/tunnels',
    name: 'tunnels',
    component: () => import('@/views/TunnelsView.vue'),
  },
  {
    path: '/cicd',
    name: 'cicd',
    component: () => import('@/views/CICDView.vue'),
  },
  {
    path: '/security',
    name: 'security',
    component: () => import('@/views/SecurityView.vue'),
  },
  {
    path: '/monitoring',
    name: 'monitoring',
    component: () => import('@/views/MonitoringView.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { requiresAdmin: true },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  if (to.meta.requiresAuth === false) {
    return true;
  }

  if (!authStore.isAuthenticated) {
    return { name: 'login' };
  }

  // On first navigation after refresh, validate the session is still valid server-side
  if (!authStore.session && authStore.token) {
    await authStore.checkSession();
    if (!authStore.isAuthenticated) {
      return { name: 'login' };
    }
  }

  return true;
});
