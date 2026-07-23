'use client'

import { motion } from 'framer-motion'
import Image from 'next/image'

const testimonials = [
  {
    name: "Sarah Chen",
    text: "This is the first backend I'm not afraid to change.",
    role: "Founder"
  },
  {
    name: "Alex Rivera",
    text: "Undo actually means undo. That's rare.",
    role: "CTO"
  },
  {
    name: "Jordan Taylor",
    text: "I stopped thinking about backend mistakes entirely.",
    role: "Founder"
  }
]

export function SocialProof() {
  return (
    <section className="relative py-24 px-6 bg-[#191919]">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-4xl sm:text-5xl font-bold text-center mb-16 text-white"
        >
          What it feels like to use Backenly
        </motion.h2>

        {/* Testimonials Grid */}
        <div className="grid md:grid-cols-3 gap-8">
          {testimonials.map((testimonial, index) => (
            <motion.div
              key={testimonial.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="group relative p-8 rounded-3xl bg-[#1f1f1f] backdrop-blur-sm border border-gray-800 hover:border-purple-500/50 hover:shadow-xl hover:shadow-purple-500/10 transition-all duration-300"
            >
              {/* Gradient overlay on hover */}
              <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 to-blue-500/5 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              
              <div className="relative">
                {/* Quote */}
                <p className="text-gray-300 text-lg mb-6 leading-relaxed">
                  "{testimonial.text}"
                </p>

                {/* User info */}
                <div className="flex items-center gap-4">
                  {/* Avatar */}
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center text-white font-semibold text-lg">
                    {testimonial.name.charAt(0)}
                  </div>
                  
                  {/* Name and role */}
                  <div>
                    <div className="font-semibold text-white">{testimonial.name}</div>
                    <div className="text-sm text-gray-400">{testimonial.role}</div>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
