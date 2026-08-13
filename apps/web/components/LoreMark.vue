<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: "xs" | "sm" | "md" | "lg";
  }>(),
  {
    size: "md",
  },
);

const sizeClass = {
  xs: "size-5",
  sm: "size-8",
  md: "size-10",
  lg: "size-12",
};
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden"
    :class="sizeClass[size]"
    aria-hidden="true"
  >
    <img
      :src="'/img/logo.png'"
      alt=""
      width="512"
      height="512"
      class="size-full object-contain"
      decoding="async"
    />
  </span>
</template>
