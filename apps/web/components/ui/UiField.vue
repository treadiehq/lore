<script setup lang="ts">
const props = defineProps<{
  label: string;
  for: string;
  hint?: string;
  error?: string;
  required?: boolean;
}>();
</script>

<template>
  <div>
    <label :for="props.for" class="lore-field-label">
      {{ props.label }}
      <span v-if="props.required" class="text-lore-danger" aria-hidden="true">*</span>
    </label>
    <div class="mt-1.5">
      <slot />
    </div>
    <p
      v-if="props.error"
      :id="`${props.for}-error`"
      class="mt-1.5 text-xs leading-5 text-lore-danger"
      role="alert"
    >
      {{ props.error }}
    </p>
    <p
      v-else-if="props.hint"
      :id="`${props.for}-hint`"
      class="mt-1.5 text-xs leading-5 text-lore-text-muted"
    >
      {{ props.hint }}
    </p>
  </div>
</template>
