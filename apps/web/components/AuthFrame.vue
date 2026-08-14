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
          <div class="auth-session-sheet auth-session-sheet-codex">
            <span class="auth-session-logo">
              <img
                :src="'/img/codex.svg'"
                alt=""
                width="16"
                height="16"
                class="size-4 object-contain"
              />
            </span>
            <span>Codex session</span>
          </div>

          <div class="auth-session-sheet auth-session-sheet-claude">
            <span class="auth-session-logo">
              <img
                :src="'/img/claude.svg'"
                alt=""
                width="16"
                height="16"
                class="size-4 object-contain"
              />
            </span>
            <span>Claude session</span>
          </div>

          <div class="auth-listening-pill">
            <span class="auth-listening-mark">
              <LoreMark size="xs" />
            </span>
            <span>Listening for teachings</span>
            <span class="auth-listening-bars">
              <span />
              <span />
              <span />
            </span>
          </div>

          <div class="auth-capture-window">
            <div class="auth-window-header">
              <div class="auth-window-heading">
                <div class="flex items-center gap-1.5">
                  <span class="auth-window-dot" />
                  <span class="auth-window-dot" />
                  <span class="auth-window-dot" />
                </div>
                <span class="auth-window-title">
                  LIVE LEARNING
                </span>
              </div>
              <span class="auth-sync-state">
                <span class="auth-live-dot" />
                Synced
              </span>
            </div>

            <div class="auth-window-body">
              <div class="auth-teaching-card">
                <div class="auth-teaching-source">
                  <span class="auth-source-mark">
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
                <p class="auth-teaching-copy">
                  “Keep authentication checks at route boundaries.”
                </p>

                <div class="auth-memory-receipt">
                  <span class="auth-memory-identity">
                    <LoreMark size="xs" />
                    Remembered by Lore
                  </span>
                  <span class="auth-memory-context">
                    Workspace convention
                  </span>
                  <span class="auth-memory-agents">
                    <span class="auth-memory-dot" />
                    3 agents ready
                  </span>
                </div>
              </div>

              <p class="auth-agent-eyebrow">
                Available in context
              </p>

              <div class="auth-agent-tray">
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
                  <span class="auth-agent-copy">
                    <span>Claude</span>
                    <span class="auth-agent-state">
                      <span class="auth-agent-dot" />
                      Ready
                    </span>
                  </span>
                </div>
                <div class="auth-agent-card">
                  <span class="auth-agent-mark">
                    <img
                      :src="'/img/codex.svg'"
                      alt=""
                      width="18"
                      height="18"
                      class="size-4 object-contain"
                    />
                  </span>
                  <span class="auth-agent-copy">
                    <span>Codex</span>
                    <span class="auth-agent-state">
                      <span class="auth-agent-dot" />
                      Ready
                    </span>
                  </span>
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
                  <span class="auth-agent-copy">
                    <span>Devin</span>
                    <span class="auth-agent-state">
                      <span class="auth-agent-dot" />
                      Ready
                    </span>
                  </span>
                </div>
              </div>

              <div class="auth-window-footer">
                <span class="auth-window-scope">
                  <span class="auth-scope-dot" />
                  Scoped to acme/web
                </span>
                <span class="auth-window-footer-note">
                  Shared workspace knowledge
                </span>
              </div>
            </div>
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
    radial-gradient(circle at 17% 21%, rgb(102 136 255 / 36%), transparent 36%),
    radial-gradient(circle at 94% 63%, rgb(193 120 255 / 22%), transparent 34%),
    linear-gradient(150deg, #151a35 0%, #0b0d18 48%, #090a0e 100%);
}

.auth-showcase::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: radial-gradient(circle, rgb(255 255 255 / 13%) 1px, transparent 1.2px);
  background-position: -0.25rem -0.25rem;
  background-size: 1rem 1rem;
  content: "";
  mask-image:
    radial-gradient(ellipse at 14% 27%, black, transparent 46%),
    radial-gradient(ellipse at 87% 74%, black, transparent 42%);
}

.auth-showcase::after {
  position: absolute;
  top: 49%;
  left: -18%;
  z-index: -1;
  width: 138%;
  height: 13rem;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 50%;
  content: "";
  rotate: -13deg;
  box-shadow:
    0 1.5rem 0 -1px rgb(255 255 255 / 3%),
    0 3rem 0 -1px rgb(144 163 255 / 4%);
}

.auth-showcase-orb {
  position: absolute;
  border: 1px solid rgb(255 255 255 / 7%);
  border-radius: 999px;
  background: transparent;
}

.auth-showcase-orb-left {
  top: 16%;
  left: -8rem;
  width: 25rem;
  height: 18rem;
  rotate: -12deg;
  box-shadow:
    0 1.2rem 0 -1px rgb(255 255 255 / 5%),
    0 2.4rem 0 -1px rgb(255 255 255 / 3%);
}

.auth-showcase-orb-right {
  right: -12rem;
  bottom: 4%;
  width: 28rem;
  height: 19rem;
  rotate: 18deg;
  box-shadow:
    0 -1.2rem 0 -1px rgb(255 255 255 / 5%),
    0 -2.4rem 0 -1px rgb(255 255 255 / 3%);
}

.auth-product-scene {
  position: relative;
  isolation: isolate;
  padding-top: 2rem;
}

.auth-session-sheet {
  position: absolute;
  top: 0.55rem;
  z-index: -1;
  display: flex;
  height: 6.5rem;
  align-items: flex-start;
  gap: 0.4rem;
  border: 1px solid rgb(255 255 255 / 13%);
  border-radius: 1.1rem;
  padding: 0.75rem 0.9rem;
  box-shadow: 0 14px 28px rgb(0 0 0 / 14%);
  color: rgb(255 255 255 / 76%);
  font-size: 0.625rem;
  font-weight: 600;
  transform-origin: center;
}

.auth-session-sheet-codex {
  right: 6%;
  left: 5%;
  background: linear-gradient(135deg, #a6b5ef, #6476dc 62%, #4554b8);
  rotate: -3.5deg;
}

.auth-session-sheet-claude {
  right: 4%;
  left: 8%;
  background: linear-gradient(135deg, #dccaf2, #9d79c7 60%, #6d4c94);
  rotate: 3.5deg;
}

.auth-session-logo {
  display: inline-flex;
  width: 1.25rem;
  height: 1.25rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(255 255 255 / 48%);
  border-radius: 0.4rem;
  background: rgb(255 255 255 / 72%);
}

.auth-listening-pill {
  position: absolute;
  top: 1.8rem;
  left: 50%;
  z-index: 3;
  display: flex;
  min-height: 2.1rem;
  translate: -50% -50%;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 999px;
  background: rgb(15 17 24 / 97%);
  padding: 0.35rem 0.65rem 0.35rem 0.4rem;
  box-shadow: 0 10px 24px rgb(0 0 0 / 24%);
  color: rgb(255 255 255 / 82%);
  font-size: 0.625rem;
  font-weight: 600;
  white-space: nowrap;
  backdrop-filter: blur(10px);
}

.auth-listening-mark {
  display: inline-flex;
  width: 1.45rem;
  height: 1.45rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(255 255 255 / 9%);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 7%);
  color: #b9c9ff;
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
  background: linear-gradient(to bottom, #8fa9ff, #c788ef);
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
  position: relative;
  z-index: 2;
  overflow: hidden;
  border: 1px solid rgb(255 255 255 / 76%);
  border-radius: 1.15rem;
  background: linear-gradient(145deg, rgb(255 255 255 / 96%), rgb(239 239 236 / 94%));
  box-shadow:
    0 24px 48px rgb(0 0 0 / 25%),
    inset 0 1px rgb(255 255 255 / 70%);
  backdrop-filter: blur(14px);
  animation: auth-float 7s ease-in-out infinite;
}

.auth-window-header {
  display: flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgb(24 24 27 / 9%);
  padding: 0.6rem 0.85rem;
}

.auth-window-heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.auth-window-dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: rgb(24 24 27 / 17%);
}

.auth-window-title {
  color: rgb(39 39 42 / 48%);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.09em;
}

.auth-sync-state {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  border-radius: 999px;
  background: rgb(24 24 27 / 5%);
  padding: 0.22rem 0.45rem;
  color: rgb(39 39 42 / 50%);
  font-size: 0.5rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.auth-window-body {
  padding: 0.75rem;
}

.auth-teaching-card {
  overflow: hidden;
  border: 1px solid rgb(24 24 27 / 9%);
  border-radius: 0.7rem;
  background: rgb(255 255 255 / 62%);
  padding: 0.7rem 0.7rem 0;
}

.auth-teaching-source {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: rgb(39 39 42 / 50%);
  font-size: 0.6875rem;
  font-weight: 600;
}

.auth-source-mark {
  display: inline-flex;
  width: 1.35rem;
  height: 1.35rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(24 24 27 / 8%);
  border-radius: 0.45rem;
  background: rgb(24 24 27 / 4%);
}

.auth-teaching-copy {
  margin-top: 0.5rem;
  color: rgb(24 24 27 / 90%);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.25rem;
}

.auth-memory-receipt {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.45rem;
  margin: 0.65rem -0.7rem 0;
  border-top: 1px solid rgb(24 24 27 / 8%);
  background: linear-gradient(90deg, #eff2fc, #f1f0f7 54%, #edf4f0);
  padding: 0.42rem 0.65rem;
}

.auth-memory-identity {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: rgb(24 24 27 / 78%);
  font-size: 0.6rem;
  font-weight: 700;
  white-space: nowrap;
}

.auth-memory-identity :deep(img) {
  filter: brightness(0);
  opacity: 0.72;
}

.auth-memory-context {
  color: rgb(63 63 70 / 53%);
  font-size: 0.55rem;
  white-space: nowrap;
}

.auth-memory-agents {
  display: inline-flex;
  margin-left: auto;
  align-items: center;
  gap: 0.35rem;
  color: #688777;
  font-size: 0.55rem;
  font-weight: 700;
  white-space: nowrap;
}

.auth-memory-dot,
.auth-agent-dot {
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 999px;
  background: #72b095;
}

.auth-agent-eyebrow {
  margin: 0.65rem 0.1rem 0.35rem;
  color: rgb(63 63 70 / 48%);
  font-size: 0.5rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.auth-agent-tray {
  display: grid;
  overflow: hidden;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid rgb(24 24 27 / 8%);
  border-radius: 0.7rem;
  background: rgb(255 255 255 / 43%);
}

.auth-agent-card {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.45rem;
  padding: 0.55rem 0.5rem;
  color: rgb(39 39 42 / 72%);
  font-size: 0.625rem;
  font-weight: 700;
}

.auth-agent-card + .auth-agent-card {
  border-left: 1px solid rgb(24 24 27 / 8%);
}

.auth-agent-mark {
  display: inline-flex;
  width: 1.5rem;
  height: 1.5rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(24 24 27 / 8%);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 68%);
  font-size: 0.625rem;
}

.auth-agent-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.15rem;
}

.auth-agent-state {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: #5e927c;
  font-size: 0.5625rem;
  font-weight: 600;
}

.auth-window-footer {
  display: flex;
  min-height: 1.85rem;
  align-items: center;
  justify-content: space-between;
  margin-top: 0.6rem;
  border-top: 1px solid rgb(24 24 27 / 8%);
  padding: 0.45rem 0.1rem 0;
  color: rgb(63 63 70 / 50%);
  font-size: 0.5rem;
}

.auth-window-scope {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.auth-scope-dot {
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 999px;
  background: #7b8edc;
}

.auth-window-footer-note {
  color: rgb(63 63 70 / 43%);
}

.auth-live-dot {
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 999px;
  background: var(--lore-success);
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

@media (max-width: 74.999rem) {
  .auth-memory-context,
  .auth-window-footer-note {
    display: none;
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
