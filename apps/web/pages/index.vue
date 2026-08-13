<script setup lang="ts">
const auth = useAuth();
const session = await auth.getSession({ force: true });
await navigateTo(session === null ? "/login" : "/activity", { replace: true });
</script>

<template>
  <p class="p-6 text-sm text-lore-text-secondary">Opening Lore…</p>
</template>
