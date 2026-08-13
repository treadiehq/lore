<script setup lang="ts">
withDefaults(
  defineProps<{
    type?: "button" | "submit" | "reset";
    variant?: "primary" | "secondary" | "ghost" | "danger";
    disabled?: boolean;
    block?: boolean;
  }>(),
  {
    type: "button",
    variant: "secondary",
    disabled: false,
    block: false,
  },
);

defineEmits<{
  click: [event: MouseEvent];
}>();
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="[
      `lore-button-${variant}`,
      block ? 'w-full' : '',
    ]"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>
