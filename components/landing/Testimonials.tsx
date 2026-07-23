'use client'

import { memo } from 'react'
import { motion } from 'framer-motion'

const testimonials = [
  {
    name: 'Sarah Chen',
    handle: '@sarahbuilds',
    avatar: 'https://i.pravatar.cc/150?img=1',
    quote: 'Favorite tool of the week: Backenly. It is still in Beta but it already saved me so much time!',
  },
  {
    name: 'Alex Rivera',
    handle: '@alexcodes',
    avatar: 'https://i.pravatar.cc/150?img=12',
    quote: 'We started building with Backenly. It\'s a crazy to see how much faster we are able to ship at our startup. Looking forward to the next round of updates, especially the real-time features',
  },
  {
    name: 'Jordan Taylor',
    handle: '@jordandev',
    avatar: 'https://i.pravatar.cc/150?img=32',
    quote: 'Just received early access to Backenly. Can\'t wait to see what this platform is capable of',
  },
  {
    name: 'Morgan Blake',
    handle: '@morganbuilds',
    avatar: 'https://i.pravatar.cc/150?img=27',
    quote: 'Shoutout to Backenly. Love how quickly I can build new backends without thinking about DevOps at all',
  },
  {
    name: 'Casey Park',
    handle: '@caseytech',
    avatar: 'https://i.pravatar.cc/150?img=49',
    quote: 'I am a big fan of the Backenly team. They are lighting fast with their replies to any question',
  },
  {
    name: 'Riley Kim',
    handle: '@rileyship',
    avatar: 'https://i.pravatar.cc/150?img=16',
    quote: 'Backenly is my new favorite way to build automations at our agency. It is fast and we do not need to think about hosting at all. Hope they add more integrations soon',
  },
]

export const Testimonials = memo(function Testimonials() {
  return (
    <section className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#1a0f2e]/10 to-transparent pointer-events-none"></div>
      
      <div className="max-w-7xl mx-auto relative z-10">
        <motion.div
          className="text-center mb-16"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-4 tracking-tight">
            Loved by builders around the world
          </h2>
        </motion.div>

        {/* Masonry Grid Layout */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 auto-rows-max">
          {testimonials.map((testimonial, index) => (
            <motion.div
              key={index}
              className="bg-[#0f1419] border border-white/10 rounded-2xl p-6 hover:border-white/20 hover:bg-white/5 transition-all duration-300 group flex flex-col will-change-transform"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ 
                duration: 0.35, 
                delay: index * 0.05,
                ease: [0.16, 1, 0.3, 1],
              }}
              whileHover={{ 
                y: -5,
              }}
            >
              {/* Profile Header */}
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full overflow-hidden bg-gradient-to-br from-purple-500 to-blue-500 flex-shrink-0">
                  <img
                    src={testimonial.avatar}
                    alt={testimonial.name}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div>
                  <p className="text-white font-semibold text-base">
                    {testimonial.name}
                  </p>
                  <p className="text-sm text-gray-400">
                    {testimonial.handle}
                  </p>
                </div>
              </div>

              {/* Testimonial Text */}
              <p className="text-gray-300 leading-relaxed group-hover:text-white transition-colors duration-300">
                {testimonial.quote}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
})
