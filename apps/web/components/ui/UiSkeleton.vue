<script setup lang="ts">
withDefaults(
  defineProps<{
    rows?: number;
  }>(),
  {
    rows: 4,
  },
);
</script>

<template>
  <div class="overflow-hidden rounded-[0.625rem] border border-lore-border bg-lore-surface">
    <div
      v-for="row in rows"
      :key="row"
      class="grid grid-cols-[minmax(0,1fr)_8rem] gap-5 border-b border-lore-border px-4 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1.4fr)_minmax(10rem,0.6fr)_7rem]"
      aria-hidden="true"
    >
      <div class="space-y-2">
        <div class="lore-skeleton h-3.5 w-4/5" />
        <div class="lore-skeleton h-3 w-2/5" />
      </div>
      <div class="hidden space-y-2 sm:block">
        <div class="lore-skeleton h-3 w-3/4" />
        <div class="lore-skeleton h-3 w-1/2" />
      </div>
      <div class="lore-skeleton h-6 w-20 justify-self-end" />
    </div>
    <span class="sr-only" role="status">Loading…</span>
  </div>
</template>
