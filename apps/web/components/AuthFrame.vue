<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description: string;
    eyebrow?: string;
  }>(),
  {
    eyebrow: "Workspace access",
  },
);
</script>

<template>
  <section class="lore-auth-shell grid min-h-dvh lg:h-dvh lg:min-h-0 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(30rem,1.2fr)] lg:overflow-hidden">
    <aside
      class="auth-showcase relative hidden overflow-hidden border-r border-lore-border p-8 lg:flex lg:h-full lg:min-h-0 lg:flex-col xl:p-12"
    >
      <div class="auth-showcase-orb auth-showcase-orb-left" aria-hidden="true" />
      <div class="auth-showcase-orb auth-showcase-orb-right" aria-hidden="true" />

      <NuxtLink
        to="/login"
        class="lore-focus relative z-10 flex w-fit items-center gap-2 rounded-lg"
        aria-label="Lore"
      >
        <LoreMark size="sm" />
        <span class="text-sm font-semibold tracking-tight text-lore-text">Lore</span>
      </NuxtLink>

      <div class="relative z-10 my-auto w-full max-w-lg py-4 xl:py-8">
        <div class="max-w-md">
          <p class="text-xs font-semibold text-white/55">
            Connect once
          </p>
          <p class="mt-3 text-2xl font-semibold leading-9 tracking-tight text-white xl:text-3xl xl:leading-10">
            Tell your agents once. Lore remembers.
          </p>
          <p class="mt-3 max-w-sm text-sm leading-6 text-white/60">
            Explicit teachings and corrections become workspace knowledge
            automatically, ready for every relevant connected agent.
          </p>
        </div>

        <div class="auth-product-scene mt-7" aria-hidden="true">
          <div class="auth-listening-pill">
            <span class="auth-listening-bars">
              <span />
              <span />
              <span />
            </span>
            Listening for teachings
          </div>

          <div class="auth-capture-window">
            <div class="flex items-center justify-between border-b border-white/8 px-4 py-2.5">
              <div class="flex items-center gap-1.5">
                <span class="size-2 rounded-full bg-lore-danger/80" />
                <span class="size-2 rounded-full bg-lore-warning/80" />
                <span class="size-2 rounded-full bg-lore-success/80" />
              </div>
              <span class="text-[0.625rem] font-medium tracking-wide text-white/35">
                LIVE LEARNING
              </span>
              <span class="size-1.5 rounded-full bg-lore-success auth-live-dot" />
            </div>

            <div class="p-3">
              <div class="rounded-lg border border-white/8 bg-white/5 p-2.5">
                <div class="flex items-center gap-2 text-[0.6875rem] text-white/45">
                  <span class="inline-flex size-5 items-center justify-center rounded-md bg-white/8 font-semibold text-white/70">
                    <img
                      :src="'/img/codex.svg'"
                      alt=""
                      width="16"
                      height="16"
                      class="size-3.5 object-contain"
                    />
                  </span>
                  Codex · acme/web
                </div>
                <p class="mt-2 text-xs leading-5 text-white/85">
                  “Keep authentication checks at route boundaries.”
                </p>
              </div>

              <div class="my-2.5 flex items-center gap-2">
                <span class="auth-flow-line" />
                <span class="rounded-full flex items-center gap-1 border border-lore-accent/25 bg-lore-accent/10 px-2 py-1 text-[0.625rem] font-semibold text-lore-accent">
                  <span>Remembered by</span>
                  <span class="text-lore-accent flex items-center gap-0.5">
                    <LoreMark size="xs" />
                    <span class="text-xs">Lore</span>
                  </span>
                </span>
                <span class="auth-flow-line auth-flow-line-reverse" />
              </div>

              <div class="grid grid-cols-3 gap-2">
                <div class="auth-agent-card">
                  <span class="auth-agent-mark">
                    <img
                      :src="'/img/claude.svg'"
                      alt=""
                      width="18"
                      height="18"
                      class="size-4 object-contain"
                    />
                  </span>
                  <span>Claude</span>
                  <span class="auth-agent-state">Ready</span>
                </div>
                <div class="auth-agent-card">
                  <span class="auth-agent-mark">
                    <img
                      :src="'/img/devin.svg'"
                      alt=""
                      width="18"
                      height="18"
                      class="size-4 object-contain"
                    />
                  </span>
                  <span>Devin</span>
                  <span class="auth-agent-state">Ready</span>
                </div>
                <div class="auth-agent-card">
                  <span class="auth-agent-mark">
                    <img
                      :src="'/img/github.svg'"
                      alt=""
                      width="18"
                      height="18"
                      class="size-4 object-contain brightness-0 invert"
                    />
                  </span>
                  <span>GitHub</span>
                  <span class="auth-agent-state">Ready</span>
                </div>
              </div>
            </div>
          </div>

          <div class="auth-scope-chip">
            <span class="size-1.5 rounded-full bg-lore-accent" />
            Scoped to acme/web
          </div>
        </div>
      </div>

      <p class="relative z-10 text-xs text-white/35">
        <!-- No separate knowledge base to maintain. -->
        Shared engineering knowledge, kept in scope.
      </p>
    </aside>

    <main class="flex min-h-dvh items-start justify-center px-5 py-8 sm:px-8 sm:py-12 lg:h-full lg:min-h-0 lg:items-center lg:overflow-y-auto">
      <div class="w-full max-w-md">
        <NuxtLink
          to="/login"
          class="lore-focus mb-10 flex w-fit items-center gap-2 rounded-lg lg:hidden"
          aria-label="Lore"
        >
          <LoreMark size="xs" />
          <span class="text-sm font-semibold text-lore-text">Lore</span>
        </NuxtLink>

        <p class="lore-page-eyebrow">
          {{ eyebrow }}
        </p>
        <h1 class="lore-page-title mt-2 sm:text-3xl sm:leading-10">
          {{ title }}
        </h1>
        <p class="mt-2 text-sm leading-6 text-lore-text-secondary">
          {{ description }}
        </p>

        <div class="mt-6">
          <slot />
        </div>
      </div>
    </main>
  </section>
</template>

<style scoped>
.auth-showcase {
  isolation: isolate;
  background:
    radial-gradient(circle at 18% 24%, rgb(147 197 253 / 22%), transparent 34%),
    radial-gradient(circle at 86% 78%, rgb(192 132 252 / 16%), transparent 32%),
    radial-gradient(circle at 78% 12%, rgb(217 181 104 / 10%), transparent 24%),
    linear-gradient(145deg, #111318 0%, #17171b 48%, #0b0b0d 100%);
}

.auth-showcase::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image:
    linear-gradient(rgb(255 255 255 / 2.5%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 2.5%) 1px, transparent 1px);
  background-size: 44px 44px;
  content: "";
  mask-image: linear-gradient(to bottom, transparent, black 20%, black 82%, transparent);
}

.auth-showcase-orb {
  position: absolute;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 42% 58% 64% 36% / 42% 38% 62% 58%;
  background: rgb(255 255 255 / 3%);
  filter: blur(0.2px);
}

.auth-showcase-orb-left {
  top: 17%;
  left: -7rem;
  width: 18rem;
  height: 22rem;
  rotate: -18deg;
}

.auth-showcase-orb-right {
  right: -8rem;
  bottom: 5%;
  width: 20rem;
  height: 17rem;
  rotate: 24deg;
}

.auth-product-scene {
  position: relative;
  padding-top: 1rem;
}

.auth-listening-pill {
  position: absolute;
  top: 0;
  left: 50%;
  z-index: 2;
  display: flex;
  min-height: 2rem;
  translate: -50% -50%;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid rgb(255 255 255 / 10%);
  border-radius: 999px;
  background: rgb(5 6 8 / 82%);
  padding: 0.4rem 0.75rem;
  box-shadow: 0 8px 24px rgb(0 0 0 / 24%);
  color: rgb(255 255 255 / 62%);
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.025em;
  white-space: nowrap;
  backdrop-filter: blur(10px);
}

.auth-listening-bars {
  display: inline-flex;
  height: 0.75rem;
  align-items: center;
  gap: 2px;
}

.auth-listening-bars span {
  width: 2px;
  border-radius: 999px;
  background: var(--lore-accent);
  animation: auth-listen 1.1s ease-in-out infinite;
}

.auth-listening-bars span:nth-child(1) {
  height: 35%;
}

.auth-listening-bars span:nth-child(2) {
  height: 90%;
  animation-delay: 140ms;
}

.auth-listening-bars span:nth-child(3) {
  height: 55%;
  animation-delay: 280ms;
}

.auth-capture-window {
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 11%);
  border-radius: 0.625rem;
  background: rgb(5 6 8 / 74%);
  box-shadow:
    0 16px 40px rgb(0 0 0 / 28%),
    inset 0 1px rgb(255 255 255 / 4%);
  backdrop-filter: blur(14px);
  animation: auth-float 7s ease-in-out infinite;
}

.auth-flow-line {
  height: 1px;
  min-width: 1rem;
  flex: 1;
  background: linear-gradient(90deg, transparent, rgb(147 197 253 / 55%));
}

.auth-flow-line-reverse {
  rotate: 180deg;
}

.auth-agent-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 3.5%);
  padding: 0.5rem 0.25rem;
  color: rgb(255 255 255 / 68%);
  font-size: 0.625rem;
  font-weight: 600;
}

.auth-agent-mark {
  display: inline-flex;
  width: 1.5rem;
  height: 1.5rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 5%);
  color: rgb(255 255 255 / 85%);
  font-size: 0.625rem;
}

.auth-agent-state {
  color: var(--lore-success);
  font-size: 0.5625rem;
  font-weight: 500;
}

.auth-scope-chip {
  position: absolute;
  right: -0.75rem;
  bottom: -0.55rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid rgb(255 255 255 / 9%);
  border-radius: 0.5rem;
  background: rgb(13 14 18 / 88%);
  padding: 0.45rem 0.65rem;
  box-shadow: 0 8px 24px rgb(0 0 0 / 22%);
  color: rgb(255 255 255 / 52%);
  font-size: 0.625rem;
  backdrop-filter: blur(10px);
}

.auth-live-dot {
  box-shadow: 0 0 0 4px rgb(114 199 165 / 10%);
  animation: auth-pulse 2s ease-out infinite;
}

@keyframes auth-float {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(-2px);
  }
}

@keyframes auth-listen {
  0%,
  100% {
    scale: 1 0.65;
    opacity: 0.55;
  }

  50% {
    scale: 1 1;
    opacity: 1;
  }
}

@keyframes auth-pulse {
  0% {
    box-shadow: 0 0 0 0 rgb(114 199 165 / 20%);
  }

  100% {
    box-shadow: 0 0 0 7px rgb(114 199 165 / 0%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .auth-capture-window,
  .auth-live-dot,
  .auth-listening-bars span {
    animation: none;
  }
}
</style>
