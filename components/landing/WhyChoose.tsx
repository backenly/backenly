'use client'

import { motion } from 'framer-motion'
import { Check, X, AlertTriangle } from 'lucide-react'
import { Logo } from '@/components/Logo'

const features = [
  'Plain-English backend',
  'Safe undo for backend changes',
  'Deployment rollback guaranteed',
  'No hidden state',
  'Multi-tenant isolation verified',
  'No DevOps required'
]

const platforms = [
  { name: 'Backenly', logo: 'backenly' },
  { name: 'Supabase', logo: 'supabase' },
  { name: 'Firebase', logo: 'firebase' }
]

const getIcon = (featureIndex: number, platformIndex: number) => {
  // Backenly has all features
  if (platformIndex === 0) return <Check className="w-5 h-5 text-emerald-400" />
  
  // Supabase/Firebase - only last feature (No DevOps) gets partial
  if (featureIndex === 5 && platformIndex > 0) return <AlertTriangle className="w-5 h-5 text-yellow-500" />
  
  return <X className="w-5 h-5 text-gray-600" />
}

export function WhyChoose() {
  return (
    <section className="relative py-32 px-6 bg-gradient-to-br from-white via-purple-50/30 to-blue-50/30 overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-gradient-to-br from-purple-200/20 to-blue-200/20 rounded-full blur-3xl" />
      
      <div className="relative max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl sm:text-5xl font-bold mb-4 bg-gradient-to-br from-gray-900 via-gray-800 to-gray-700 bg-clip-text text-transparent">
            Why founders choose Backenly
          </h2>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto">
            The only backend platform with built-in safety guarantees
          </p>
        </motion.div>

        {/* Glassmorphism comparison card */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="relative rounded-3xl overflow-hidden bg-white/70 backdrop-blur-xl border border-white/20 shadow-2xl shadow-purple-500/10"
        >
          {/* Header row with platform logos */}
          <div className="grid grid-cols-4 gap-4 p-6 bg-gradient-to-r from-purple-50/50 to-blue-50/50 border-b border-gray-200/50">
            <div className="col-span-1" />
            {platforms.map((platform) => (
              <div
                key={platform.name}
                className="flex flex-col items-center justify-center gap-2"
              >
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                  platform.name === 'Backenly'
                    ? 'bg-gradient-to-br from-purple-600 to-blue-600'
                    : 'bg-gray-100'
                }`}>
                  {platform.logo === 'backenly' && (
                    <div className="w-6 h-6 flex items-center justify-center text-white">
                      <Logo />
                    </div>
                  )}
                  {platform.logo === 'supabase' && (
                    <svg className="w-5 h-5" viewBox="0 0 109 113" fill="none">
                      <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#paint0_linear)" />
                      <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z" fill="url(#paint1_linear)" fillOpacity="0.2" />
                      <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z" fill="#3ECF8E" />
                      <defs>
                        <linearGradient id="paint0_linear" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
                          <stop stopColor="#249361" />
                          <stop offset="1" stopColor="#3ECF8E" />
                        </linearGradient>
                        <linearGradient id="paint1_linear" x1="36.1558" y1="30.578" x2="54.4844" y2="65.0806" gradientUnits="userSpaceOnUse">
                          <stop />
                          <stop offset="1" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                    </svg>
                  )}
                  {platform.logo === 'firebase' && (
                    <svg className="w-5 h-5" viewBox="0 0 256 351" fill="none">
                      <path d="M1.25273 280.732L1.75273 280.732L1.75273 280.232L1.25273 280.232L1.25273 280.732Z" fill="#FFA000" />
                      <path d="M134.417 148.974L110.393 122.589L94.3929 140.064L128.064 174.223L134.417 148.974Z" fill="#F57F17" />
                      <path d="M128.064 174.223L94.3929 140.064L48.3643 186.873L128.064 261.875L128.064 174.223Z" fill="#FFCA28" />
                      <path d="M97.5625 1.06055L48.3643 186.873L94.3929 140.064L110.393 122.589L134.417 148.974L97.5625 1.06055Z" fill="#FFA000" />
                      <path d="M207.764 165.129C207.764 171.464 203.768 175.46 197.433 175.46C191.098 175.46 187.102 171.464 187.102 165.129C187.102 158.794 191.098 154.798 197.433 154.798C203.768 154.798 207.764 158.794 207.764 165.129Z" fill="#FFA000" />
                      <path d="M128.064 174.223L207.764 165.129L197.433 54.577L134.417 148.974L128.064 174.223Z" fill="#F57F17" />
                      <path d="M197.433 54.577L128.064 261.875L207.764 165.129L197.433 54.577Z" fill="#FFCA28" />
                    </svg>
                  )}
                </div>
                <span className={`text-sm font-semibold ${
                  platform.name === 'Backenly' ? 'text-purple-600' : 'text-gray-600'
                }`}>
                  {platform.name}
                </span>
              </div>
            ))}
          </div>

          {/* Feature rows */}
          <div className="divide-y divide-gray-200/50">
            {features.map((feature, featureIndex) => (
              <motion.div
                key={feature}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.3 + featureIndex * 0.05 }}
                className="grid grid-cols-4 gap-4 p-6 hover:bg-purple-50/30 transition-colors"
              >
                <div className="col-span-1 text-left flex items-center">
                  <span className="text-gray-800 text-sm font-medium">{feature}</span>
                </div>
                {platforms.map((_, platformIndex) => (
                  <div key={platformIndex} className="flex justify-center items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      platformIndex === 0
                        ? 'bg-green-100'
                        : featureIndex === 5 && platformIndex > 0
                        ? 'bg-yellow-100'
                        : 'bg-gray-100'
                    }`}>
                      {getIcon(featureIndex, platformIndex)}
                    </div>
                  </div>
                ))}
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Bottom note */}
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.8 }}
          className="text-center text-sm text-gray-600 mt-8"
        >
          <AlertTriangle className="w-4 h-4 inline text-yellow-500 mr-1" />
          Partial support · Based on public documentation as of 2026
        </motion.p>
      </div>
    </section>
  )
}
