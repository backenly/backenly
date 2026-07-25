/**
 * FRONTEND FRAMEWORK DETECTOR
 * ============================
 * Detects the frontend framework from user messages and generates
 * framework-specific SDK integration code.
 *
 * Supported frameworks:
 *   React, Next.js, Vue, Nuxt, Angular, Svelte, SvelteKit, plain JS
 *
 * Example:
 *   User: "I'm building a Next.js app"
 *   Agent: generates Next.js-specific server action code
 *
 *   User: "using React with Vite"
 *   Agent: generates React hooks-style code
 */

export type FrontendFramework =
  | 'nextjs'
  | 'react'
  | 'vue'
  | 'nuxt'
  | 'angular'
  | 'svelte'
  | 'sveltekit'
  | 'vanilla'
  | 'unknown'

export interface FrameworkSnippet {
  framework: FrontendFramework
  label: string
  installCommand: string
  setupCode: string
  usageExample: string
}

// ─── Framework Detection ─────────────────────────────────────────────────────

const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; framework: FrontendFramework }> = [
  { pattern: /next\.?js|nextjs|next app|app router|pages router/i, framework: 'nextjs' },
  { pattern: /nuxt/i, framework: 'nuxt' },
  { pattern: /sveltekit|svelte kit/i, framework: 'sveltekit' },
  { pattern: /svelte/i, framework: 'svelte' },
  { pattern: /angular/i, framework: 'angular' },
  { pattern: /vue\.?js|vuejs|vue 3|composition api/i, framework: 'vue' },
  { pattern: /react|create.react.app|vite.*react|react.*vite/i, framework: 'react' },
  { pattern: /vanilla|plain.*js|no framework|html.*js|jquery/i, framework: 'vanilla' },
]

/**
 * Detect framework from user message or conversation history.
 * Returns 'unknown' if no framework is mentioned.
 */
export function detectFrontendFramework(
  message: string,
  conversationHistory?: Array<{ role: string; content: string }>
): FrontendFramework {
  // Check current message first
  for (const { pattern, framework } of FRAMEWORK_PATTERNS) {
    if (pattern.test(message)) return framework
  }

  // Check recent conversation history
  if (conversationHistory) {
    const recentHistory = conversationHistory.slice(-10).map(h => h.content).join(' ')
    for (const { pattern, framework } of FRAMEWORK_PATTERNS) {
      if (pattern.test(recentHistory)) return framework
    }
  }

  return 'unknown'
}

// ─── Framework-Specific Code Generation ──────────────────────────────────────

export function generateFrameworkSnippet(
  framework: FrontendFramework,
  projectId: string,
  publicKey: string
): FrameworkSnippet {
  switch (framework) {
    case 'nextjs':
      return {
        framework,
        label: 'Next.js',
        installCommand: 'npm install @backenly/sdk',
        setupCode: `// lib/backend.ts
import { BackenlyClient } from '@backenly/sdk'

export const backend = new BackenlyClient({
  projectId: '${projectId}',
  publicKey: '${publicKey}',
})`,
        usageExample: `// app/page.tsx (Server Component)
import { backend } from '@/lib/backend'

export default async function Page() {
  const posts = await backend.posts.list()
  return <div>{posts.map(p => <p key={p.id}>{p.title}</p>)}</div>
}

// app/actions.ts (Server Action)
'use server'
import { backend } from '@/lib/backend'

export async function createPost(data: FormData) {
  return backend.posts.create({ title: data.get('title') as string })
}`,
      }

    case 'react':
      return {
        framework,
        label: 'React',
        installCommand: 'npm install @backenly/sdk',
        setupCode: `// src/lib/backend.ts
import { BackenlyClient } from '@backenly/sdk'

export const backend = new BackenlyClient({
  projectId: '${projectId}',
  publicKey: '${publicKey}',
})`,
        usageExample: `// src/components/Posts.tsx
import { useEffect, useState } from 'react'
import { backend } from '../lib/backend'

export function Posts() {
  const [posts, setPosts] = useState([])

  useEffect(() => {
    backend.posts.list().then(setPosts)
  }, [])

  return <div>{posts.map((p: any) => <p key={p.id}>{p.title}</p>)}</div>
}`,
      }

    case 'vue':
      return {
        framework,
        label: 'Vue 3',
        installCommand: 'npm install @backenly/sdk',
        setupCode: `// src/lib/backend.ts
import { BackenlyClient } from '@backenly/sdk'

export const backend = new BackenlyClient({
  projectId: '${projectId}',
  publicKey: '${publicKey}',
})`,
        usageExample: `<!-- src/components/Posts.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { backend } from '@/lib/backend'

const posts = ref([])
onMounted(async () => {
  posts.value = await backend.posts.list()
})
</script>

<template>
  <div>
    <p v-for="post in posts" :key="post.id">{{ post.title }}</p>
  </div>
</template>`,
      }

    case 'nuxt':
      return {
        framework,
        label: 'Nuxt 3',
        installCommand: 'npm install @backenly/sdk',
        setupCode: `// plugins/backend.ts
import { BackenlyClient } from '@backenly/sdk'

export default defineNuxtPlugin(() => {
  const backend = new BackenlyClient({
    projectId: '${projectId}',
    publicKey: '${publicKey}',
  })
  return { provide: { backend } }
})`,
        usageExample: `<!-- pages/index.vue -->
<script setup lang="ts">
const { $backend } = useNuxtApp()
const { data: posts } = await useAsyncData('posts', () => $backend.posts.list())
</script>

<template>
  <div>
    <p v-for="post in posts" :key="post.id">{{ post.title }}</p>
  </div>
</template>`,
      }

    case 'svelte':
    case 'sveltekit':
      return {
        framework,
        label: framework === 'sveltekit' ? 'SvelteKit' : 'Svelte',
        installCommand: 'npm install @backenly/sdk',
        setupCode: `// src/lib/backend.ts
import { BackenlyClient } from '@backenly/sdk'

export const backend = new BackenlyClient({
  projectId: '${projectId}',
  publicKey: '${publicKey}',
})`,
        usageExample: `<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { backend } from '$lib/backend'
  import { onMount } from 'svelte'

  let posts: any[] = []
  onMount(async () => {
    posts = await backend.posts.list()
  })
</script>

{#each posts as post}
  <p>{post.title}</p>
{/each}`,
      }

    default:
      return {
        framework: 'vanilla',
        label: 'JavaScript',
        installCommand: 'npm install @backenly/sdk',
        setupCode: `import { BackenlyClient } from '@backenly/sdk'

const backend = new BackenlyClient({
  projectId: '${projectId}',
  publicKey: '${publicKey}',
})`,
        usageExample: `// Fetch data
const posts = await backend.posts.list()
console.log(posts)

// Create a record
const post = await backend.posts.create({ title: 'Hello world' })`,
      }
  }
}

/**
 * Generate a full SDK integration message tailored to the detected framework.
 */
export function formatFrameworkMessage(snippet: FrameworkSnippet): string {
  return `Done: SDK generated for ${snippet.label}.

**Install:**
\`${snippet.installCommand}\`

**Setup:**
\`\`\`ts
${snippet.setupCode}
\`\`\`

**Usage:**
\`\`\`ts
${snippet.usageExample}
\`\`\``
}
