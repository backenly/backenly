'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ArrowRight, RotateCcw, FileX, Download } from 'lucide-react'

export function SimpleCTA() {
  return (
    <section className="relative py-24 px-6 bg-[#0a0a0a]">
      <div className="max-w-5xl mx-auto">
        {/* Fear busters */}
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-4xl sm:text-5xl font-bold text-white text-center mb-12"
        >
          Build without fear
        </motion.h2>

        <div className="grid md:grid-cols-3 gap-6 mb-16">
          {[
            { icon: RotateCcw, text: 'Rollback any change', desc: 'Every change is reversible. One click restores your backend.' },
            { icon: FileX, text: 'No config files ever', desc: 'No YAML, no .env setup, no Terraform. Just describe what you want.' },
            { icon: Download, text: 'Export your code anytime', desc: 'You own everything. Export the generated code whenever you want.' },
          ].map((item, i) => (
            <motion.div
              key={item.text}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="flex items-start gap-4 p-6 rounded-2xl bg-[#111111] border border-gray-800"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <item.icon className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <p className="font-semibold text-white mb-1">✅ {item.text}</p>
                <p className="text-sm text-gray-400">{item.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Code snippet */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mb-16 rounded-2xl overflow-hidden border border-gray-800 bg-[#0d0d0d]"
        >
          <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500/60" />
            <div className="w-3 h-3 rounded-full bg-amber-500/60" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/60" />
            <span className="ml-2 text-xs text-gray-500 font-mono">app.js</span>
          </div>
          <pre className="p-6 text-sm font-mono leading-relaxed overflow-x-auto">
            <span className="text-gray-500">{'// This is all you need'}</span>{'\n'}
            <span className="text-blue-400">import</span>{' '}
            <span className="text-white">{'{ createClient }'}</span>{' '}
            <span className="text-blue-400">from</span>{' '}
            <span className="text-emerald-400">&quot;@backenly/sdk&quot;</span>{'\n'}
            <span className="text-blue-400">const</span>{' '}
            <span className="text-white">backend</span>{' = '}
            <span className="text-yellow-400">createClient</span>
            <span className="text-white">{'({ projectId: '}</span>
            <span className="text-emerald-400">&quot;your-id&quot;</span>
            <span className="text-white">{' })'}</span>{'\n\n'}
            <span className="text-white">backend.posts.</span>
            <span className="text-yellow-400">list</span>
            <span className="text-white">{'()'}</span>
            {'      '}
            <span className="text-gray-500">{'// ✅ works'}</span>{'\n'}
            <span className="text-white">backend.auth.</span>
            <span className="text-yellow-400">signUp</span>
            <span className="text-white">{'()'}</span>
            {'     '}
            <span className="text-gray-500">{'// ✅ works'}</span>{'\n'}
            <span className="text-white">backend.users.</span>
            <span className="text-yellow-400">create</span>
            <span className="text-white">{'()'}</span>
            {'    '}
            <span className="text-gray-500">{'// ✅ works'}</span>
          </pre>
        </motion.div>

        {/* CTA */}
        <div className="text-center">
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-lg text-gray-400 mb-8"
          >
            Describe what your app should do.<br />
            Backenly will handle the rest — safely.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Link
              href="/auth/signup"
              className="group inline-flex items-center gap-2 px-8 py-4 text-base font-semibold text-black bg-white hover:bg-gray-100 rounded-xl transition-all"
            >
              <span>Start building your backend</span>
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
