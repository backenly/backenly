'use client'

import { motion } from 'framer-motion'

// Integration data with brand colors - using Simple Icons format
const integrations = [
  { name: 'Python', color: '#3776AB', bg: '#3776AB', iconSlug: 'python' },
  { name: 'Node.js', color: '#339933', bg: '#339933', iconSlug: 'nodedotjs' },
  { name: 'AWS', color: '#FF9900', bg: '#FF9900', iconSlug: 'amazonaws' },
  { name: 'Google Cloud', color: '#4285F4', bg: '#4285F4', iconSlug: 'googlecloud' },
  { name: 'GitHub', color: '#181717', bg: '#181717', iconSlug: 'github' },
  { name: 'Slack', color: '#4A154B', bg: '#4A154B', iconSlug: 'slack' },
  { name: 'Discord', color: '#5865F2', bg: '#5865F2', iconSlug: 'discord' },
  { name: 'PostgreSQL', color: '#336791', bg: '#336791', iconSlug: 'postgresql' },
  { name: 'MongoDB', color: '#47A248', bg: '#47A248', iconSlug: 'mongodb' },
  { name: 'Redis', color: '#DC382D', bg: '#DC382D', iconSlug: 'redis' },
  { name: 'OpenAI', color: '#412991', bg: '#412991', iconSlug: 'openai' },
  { name: 'Anthropic', color: '#D4A574', bg: '#D4A574', iconSlug: 'anthropic' },
  { name: 'Stripe', color: '#635BFF', bg: '#635BFF', iconSlug: 'stripe' },
  { name: 'SendGrid', color: '#1A82E2', bg: '#1A82E2', iconSlug: 'sendgrid' },
  { name: 'Twilio', color: '#F22F46', bg: '#F22F46', iconSlug: 'twilio' },
  { name: 'Zapier', color: '#FF4A00', bg: '#FF4A00', iconSlug: 'zapier' },
  { name: 'Webhook', color: '#6B7280', bg: '#6B7280', iconSlug: 'webhooks' },
  { name: 'REST API', color: '#00D9FF', bg: '#00D9FF', iconSlug: 'rest' },
  { name: 'GraphQL', color: '#E10098', bg: '#E10098', iconSlug: 'graphql' },
  { name: 'Firebase', color: '#FFCA28', bg: '#FFCA28', iconSlug: 'firebase' },
  { name: 'Vercel', color: '#000000', bg: '#000000', iconSlug: 'vercel' },
  { name: 'Docker', color: '#2496ED', bg: '#2496ED', iconSlug: 'docker' },
  { name: 'Figma', color: '#F24E1E', bg: '#F24E1E', iconSlug: 'figma' },
  { name: 'Notion', color: '#000000', bg: '#000000', iconSlug: 'notion' },
  { name: 'Linear', color: '#5E6AD2', bg: '#5E6AD2', iconSlug: 'linear' },
  { name: 'Supabase', color: '#3ECF8E', bg: '#3ECF8E', iconSlug: 'supabase' },
  { name: 'HuggingFace', color: '#FFD21E', bg: '#FFD21E', iconSlug: 'huggingface' },
  { name: 'Stable Diffusion', color: '#000000', bg: '#000000', iconSlug: 'stablediffusion' },
]

// Split into rows
const row1 = integrations.slice(0, 8)
const row2 = integrations.slice(8, 16)
const row3 = integrations.slice(16, 24)
const row4 = integrations.slice(24)

// Scrolling row component
const ScrollingRow = ({ 
  items, 
  direction = 'left',
  speed = 50 
}: { 
  items: typeof integrations
  direction?: 'left' | 'right'
  speed?: number
}) => {
  const allItems = [...items, ...items, ...items]
  
  return (
    <div className="relative overflow-hidden mb-4">
      <motion.div
        className="flex gap-4"
        animate={{
          x: direction === 'left' 
            ? [0, -136 * items.length] 
            : [0, 136 * items.length],
        }}
        transition={{
          x: {
            repeat: Infinity,
            repeatType: 'loop',
            duration: speed,
            ease: 'linear',
          },
        }}
        style={{ width: 'max-content' }}
      >
        {allItems.map((integration, index) => (
          <div
            key={`${integration.name}-${index}`}
            className="flex-shrink-0 w-32 h-32 bg-white/5 border border-white/10 rounded-xl p-4 flex flex-col items-center justify-center group cursor-default relative overflow-hidden"
          >
            {/* Brand-colored background */}
            <div
              className="absolute inset-0 rounded-xl opacity-10 group-hover:opacity-20 transition-opacity duration-300"
              style={{ backgroundColor: integration.bg }}
            />
            
            {/* Animated glow effect */}
            <motion.div
              className="absolute inset-0 rounded-xl"
              style={{
                background: `radial-gradient(circle, ${integration.color}20, transparent 70%)`,
              }}
              animate={{
                scale: [1, 1.3, 1],
                opacity: [0, 0.3, 0],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: index * 0.1,
              }}
            />
            
            <motion.div 
              className="relative z-10 w-16 h-16 rounded-lg flex items-center justify-center mb-2 group-hover:scale-110 transition-transform duration-300 bg-white/10 backdrop-blur-sm"
              style={{ 
                boxShadow: `0 4px 12px ${integration.color}40`,
              }}
              whileHover={{
                boxShadow: `0 8px 24px ${integration.color}60`,
              }}
            >
              {/* Use Simple Icons CDN */}
              <img
                src={`https://cdn.simpleicons.org/${integration.iconSlug}/${integration.color.replace('#', '')}`}
                alt={integration.name}
                className="w-10 h-10 object-contain"
                loading="lazy"
                onError={(e) => {
                  // Fallback to colored box with initial
                  const target = e.target as HTMLImageElement
                  target.style.display = 'none'
                  const parent = target.parentElement
                  if (parent && !parent.querySelector('.fallback-icon')) {
                    const fallback = document.createElement('div')
                    fallback.className = 'fallback-icon w-10 h-10 rounded flex items-center justify-center text-white font-bold text-sm'
                    fallback.style.backgroundColor = integration.bg
                    fallback.textContent = integration.name.charAt(0)
                    parent.appendChild(fallback)
                  }
                }}
              />
            </motion.div>
            <p className="relative z-10 text-[10px] text-gray-400 text-center group-hover:text-white transition-colors duration-300 font-medium leading-tight">
              {integration.name}
            </p>
          </div>
        ))}
      </motion.div>
    </div>
  )
}

export function Integrations() {
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
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 tracking-tight">
            Connect any AI Model, Data Source & Tool
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto leading-relaxed">
            Integrate seamlessly with your existing stack. Browse through a large set of ready-made nodes, connect with your data, tools and agents, all without diving into raw code.
          </p>
        </motion.div>

        {/* Multiple scrolling rows with alternating directions */}
        <div className="space-y-4">
          {/* Row 1: Left */}
          <ScrollingRow items={row1} direction="left" speed={60} />
          
          {/* Row 2: Right */}
          <ScrollingRow items={row2} direction="right" speed={55} />
          
          {/* Row 3: Left */}
          <ScrollingRow items={row3} direction="left" speed={65} />
          
          {/* Row 4: Right */}
          {row4.length > 0 && <ScrollingRow items={row4} direction="right" speed={58} />}
        </div>
      </div>
    </section>
  )
}
