<script setup lang="ts">
const toast = useToast();
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-4 bottom-4 z-60 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
      aria-live="polite"
      aria-atomic="false"
    >
      <div
        v-for="item in toast.toasts.value"
        :key="item.id"
        class="pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-lore-raised p-3 text-sm shadow-[0_12px_32px_rgb(0_0_0/0.24)]"
        :class="
          item.tone === 'error'
            ? 'border-lore-danger/35'
            : 'border-lore-border-strong text-lore-text'
        "
        :role="item.tone === 'error' ? 'alert' : 'status'"
      >
        <span
          class="flex size-7 shrink-0 items-center justify-center rounded-md border"
          :class="
            item.tone === 'error'
              ? 'border-lore-danger/25 bg-lore-danger-soft text-lore-danger'
              : 'border-lore-success/25 bg-lore-success-soft text-lore-success'
          "
          aria-hidden="true"
        >
          <svg v-if="item.tone === 'error'" viewBox="0 0 16 16" fill="none" class="size-3.5">
            <path d="M8 4.25v4m0 2.5v.05" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3" />
          </svg>
          <svg v-else viewBox="0 0 16 16" fill="none" class="size-3.5">
            <path d="m4 8.25 2.5 2.5L12 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <span class="min-w-0 flex-1 pt-1 leading-5 text-lore-text">
          {{ item.message }}
        </span>
        <button
          type="button"
          class="lore-focus flex size-7 shrink-0 items-center justify-center rounded-md text-lore-text-muted hover:bg-lore-hover hover:text-lore-text"
          aria-label="Dismiss notification"
          @click="toast.dismiss(item.id)"
        >
          <svg viewBox="0 0 16 16" fill="none" class="size-3.5" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>
  </Teleport>
</template>
