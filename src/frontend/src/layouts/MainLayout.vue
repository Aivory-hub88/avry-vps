<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';

const logoLoaded = ref(true);
const logoSrc = ref('/logo.svg');

const navItems = [
  { path: '/', label: 'Dashboard', icon: '📊' },
  { path: '/containers', label: 'Containers', icon: '🐳' },
  { path: '/projects', label: 'Projects', icon: '📁' },
  { path: '/terminal', label: 'Terminal', icon: '💻' },
  { path: '/files', label: 'Files', icon: '📄' },
  { path: '/domains', label: 'Domains', icon: '🌐' },
  { path: '/jobs', label: 'Jobs', icon: '⚙️' },
  { path: '/alerts', label: 'Alerts', icon: '🔔' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

const sidebarCollapsed = ref(false);

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function handleLogoError() {
  logoLoaded.value = false;
  console.warn(
    '[Aivory VPS Panel] Logo asset not found at "/logo.svg". Falling back to text title.'
  );
}

onMounted(() => {
  // Attempt to verify logo exists by loading it
  const img = new Image();
  img.onload = () => {
    logoLoaded.value = true;
  };
  img.onerror = () => {
    handleLogoError();
  };
  img.src = logoSrc.value;
});
</script>

<template>
  <div class="layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <!-- Header -->
    <header class="layout-header">
      <div class="header-left">
        <button
          class="sidebar-toggle"
          @click="toggleSidebar"
          aria-label="Toggle sidebar"
        >
          <span class="toggle-icon">☰</span>
        </button>
        <div class="brand">
          <img
            v-if="logoLoaded"
            :src="logoSrc"
            alt="Aivory"
            class="brand-logo"
            @error="handleLogoError"
          />
          <span class="brand-title">Aivory VPS Panel</span>
        </div>
      </div>
      <div class="header-right">
        <slot name="header-actions" />
      </div>
    </header>

    <!-- Sidebar -->
    <aside class="layout-sidebar">
      <nav class="sidebar-nav" aria-label="Main navigation">
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="nav-item"
          :title="item.label"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>
    </aside>

    <!-- Main content -->
    <main class="layout-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-areas:
    "header header"
    "sidebar main";
  grid-template-columns: var(--sidebar-width) 1fr;
  grid-template-rows: var(--header-height) 1fr;
  min-height: 100vh;
  transition: grid-template-columns var(--transition-base);
}

.layout.sidebar-collapsed {
  grid-template-columns: 60px 1fr;
}

/* Header */
.layout-header {
  grid-area: header;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-lg);
  background-color: var(--color-secondary);
  border-bottom: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
  z-index: 100;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-inverse);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.sidebar-toggle:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.toggle-icon {
  font-size: var(--font-size-lg);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.brand-logo {
  height: 32px;
  max-height: 40px;
  width: auto;
  object-fit: contain;
}

.brand-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-inverse);
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

/* Sidebar */
.layout-sidebar {
  grid-area: sidebar;
  background-color: var(--color-surface);
  border-right: 1px solid var(--color-border);
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--spacing-md) 0;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: 0 var(--spacing-sm);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: var(--font-size-sm);
  font-weight: 500;
  transition: color var(--transition-fast), background-color var(--transition-fast);
  white-space: nowrap;
  overflow: hidden;
}

.nav-item:hover {
  color: var(--color-text);
  background-color: var(--color-surface-hover);
}

.nav-item.router-link-exact-active,
.nav-item.router-link-active[href="/"] {
  color: var(--color-primary);
  background-color: var(--color-primary-light);
}

.nav-icon {
  flex-shrink: 0;
  width: 20px;
  text-align: center;
  font-size: var(--font-size-base);
}

.nav-label {
  transition: opacity var(--transition-base);
}

/* Collapsed sidebar */
.sidebar-collapsed .nav-label {
  opacity: 0;
  width: 0;
  overflow: hidden;
}

.sidebar-collapsed .nav-item {
  justify-content: center;
  padding: var(--spacing-sm);
}

.sidebar-collapsed .nav-icon {
  width: auto;
}

/* Main content */
.layout-main {
  grid-area: main;
  padding: var(--spacing-lg);
  overflow-y: auto;
  background-color: var(--color-bg);
}
</style>
