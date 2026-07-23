'use client'

import { memo } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, XCircle, AlertTriangle, Wand2, Database, Zap, Globe, Code2, Shield, Cog } from 'lucide-react'
import { Logo } from '@/components/Logo'

const features = [
  {
    icon: Wand2,
    name: 'Plain-English backend',
    backenly: 'check' as const,
    supabase: 'no' as const,
    firebase: 'no' as const,
  },
  {
    icon: Database,
    name: 'Safe undo for backend changes',
    backenly: 'check' as const,
    supabase: 'no' as const,
    firebase: 'no' as const,
  },
  {
    icon: Code2,
    name: 'Guaranteed deployment rollback',
    backenly: 'check' as const,
    supabase: 'no' as const,
    firebase: 'no' as const,
  },
  {
    icon: Zap,
    name: 'No hidden state',
    backenly: 'check' as const,
    supabase: 'no' as const,
    firebase: 'no' as const,
  },
  {
    icon: Shield,
    name: 'Verified tenant isolation',
    backenly: 'check' as const,
    supabase: 'warning' as const,
    firebase: 'warning' as const,
  },
  {
    icon: Globe,
    name: 'No DevOps required',
    backenly: 'check' as const,
    supabase: 'no' as const,
    firebase: 'no' as const,
  },
]

export const Comparison = memo(function Comparison() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#1a0f2e]/10 to-transparent pointer-events-none"></div>
      
      <div className="max-w-6xl mx-auto relative z-10">
        {/* Header */}
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/20 bg-white/5 mb-6">
            <span className="text-sm text-gray-400 uppercase tracking-wider font-medium">Product Comparison</span>
          </div>
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-4 tracking-tight">
            Why founders choose{' '}
            <span className="bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
              Backenly
            </span>
            {' '}over Other Platforms
          </h2>
        </motion.div>

        {/* Comparison Table */}
        <motion.div
          className="relative"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          {/* Platform Logos Header */}
          <div className="flex items-center justify-end gap-6 mb-8">
            <motion.div
              className="flex items-center gap-3 px-6 py-3 bg-gradient-to-br from-purple-500/10 to-blue-500/10 border border-purple-500/20 rounded-xl"
              whileHover={{ scale: 1.02 }}
            >
              <Logo />
              <span className="text-lg font-bold text-white">Backenly</span>
            </motion.div>
            <motion.div
              className="flex items-center gap-3 px-6 py-3 bg-white/5 border border-white/10 rounded-xl opacity-60"
              whileHover={{ scale: 1.02 }}
            >
              <div className="w-6 h-6 rounded flex items-center justify-center">
                <svg viewBox="0 0 109 113" className="w-full h-full" fill="none">
                  <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#supabase-gradient-1)"/>
                  <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#supabase-gradient-2)" fillOpacity="0.2"/>
                  <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z" fill="#3ECF8E"/>
                  <defs>
                    <linearGradient id="supabase-gradient-1" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
                      <stop stopColor="#249361"/>
                      <stop offset="1" stopColor="#3ECF8E"/>
                    </linearGradient>
                    <linearGradient id="supabase-gradient-2" x1="36.1558" y1="30.578" x2="54.4844" y2="65.0806" gradientUnits="userSpaceOnUse">
                      <stop/>
                      <stop offset="1" stopOpacity="0"/>
                    </linearGradient>
                  </defs>
                </svg>
              </div>
              <span className="text-base font-semibold text-gray-400">Supabase</span>
            </motion.div>
            <motion.div
              className="flex items-center gap-3 px-6 py-3 bg-white/5 border border-white/10 rounded-xl opacity-60"
              whileHover={{ scale: 1.02 }}
            >
              <div className="w-6 h-6 rounded flex items-center justify-center overflow-hidden">
                <img 
                  src="/firebase-logo.png" 
                  alt="Firebase" 
                  className="w-full h-full object-contain"
                  style={{ mixBlendMode: 'screen' }}
                />
              </div>
              <span className="text-base font-semibold text-gray-400">Firebase</span>
            </motion.div>
          </div>

          {/* Feature Rows */}
          <div className="space-y-2">
            {features.map((feature, index) => {
              const Icon = feature.icon
              return (
                <motion.div
                  key={index}
                  className="group relative bg-gradient-to-r from-white/5 to-white/[0.02] border border-white/10 rounded-xl p-6 hover:border-white/20 hover:bg-white/10 transition-all duration-300"
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: '-50px' }}
                  transition={{ duration: 0.3, delay: index * 0.05 }}
                >
                  <div className="flex items-center justify-between">
                    {/* Feature Name */}
                    <div className="flex items-center gap-4 flex-1">
                      <div className="w-10 h-10 bg-white/5 border border-white/10 rounded-lg flex items-center justify-center flex-shrink-0">
                        <Icon className="w-5 h-5 text-gray-400" />
                      </div>
                      <span className="text-white font-medium text-lg">{feature.name}</span>
                    </div>

                    {/* Status Icons */}
                    <div className="flex items-center gap-6">
                      {/* Backenly */}
                      <div className="w-32 flex justify-center">
                        {feature.backenly === 'check' ? (
                          <motion.div
                            whileHover={{ scale: 1.2, rotate: 360 }}
                            transition={{ duration: 0.4 }}
                          >
                            <CheckCircle2 className="w-6 h-6 text-green-400" />
                          </motion.div>
                        ) : feature.backenly === 'warning' ? (
                          <AlertTriangle className="w-6 h-6 text-yellow-500" />
                        ) : (
                          <XCircle className="w-6 h-6 text-gray-600" />
                        )}
                      </div>

                      {/* Supabase */}
                      <div className="w-32 flex justify-center">
                        {feature.supabase === 'warning' ? (
                          <AlertTriangle className="w-6 h-6 text-yellow-500" />
                        ) : (
                          <XCircle className="w-6 h-6 text-gray-600" />
                        )}
                      </div>

                      {/* Firebase */}
                      <div className="w-32 flex justify-center">
                        {feature.firebase === 'warning' ? (
                          <AlertTriangle className="w-6 h-6 text-yellow-500" />
                        ) : (
                          <XCircle className="w-6 h-6 text-gray-600" />
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        </motion.div>
      </div>
    </section>
  )
})
