'use client'

import { motion, useInView } from 'framer-motion'
import { useState, useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'

export function LiveDemo() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })
  const [command, setCommand] = useState('')
  const [showResponse, setShowResponse] = useState(false)
  
  const fullCommand = 'curl https://taskflow.backenly.com/api/v1/todos'

  useEffect(() => {
    if (!isInView) return

    let index = 0
    const timer = setInterval(() => {
      if (index <= fullCommand.length) {
        setCommand(fullCommand.slice(0, index))
        index++
      } else {
        clearInterval(timer)
        setTimeout(() => setShowResponse(true), 500)
      }
    }, 30)

    return () => clearInterval(timer)
  }, [isInView])

  const response = {
    data: [
      {
        id: 1,
        title: 'Build landing page',
        completed: false,
        userId: 1,
        dueDate: '2024-01-15',
      },
      {
        id: 2,
        title: 'Deploy backend',
        completed: true,
        userId: 1,
        dueDate: '2024-01-14',
      },
    ],
    status: 200,
  }

  return (
    <section id="demo" className="py-32 px-4 sm:px-6 lg:px-8 bg-[#0A0E1A] relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#1a0f2e]/50 to-transparent" />
      
      <div className="max-w-5xl mx-auto relative z-10" ref={ref}>
        <motion.div
          className="text-center mb-12"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8 }}
        >
          <motion.div
            className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full bg-green-500/10 border border-green-500/20"
            whileHover={{ scale: 1.05 }}
          >
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            <span className="text-sm font-semibold text-green-400">Live in Production</span>
          </motion.div>
          <h2 className="text-5xl sm:text-6xl font-bold text-white mb-6">
            <span className="bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent">
              Real APIs.
            </span>
            <br />
            <span className="text-white">Real Fast.</span>
          </h2>
        </motion.div>

        {/* Terminal */}
        <motion.div
          className="relative"
          initial={{ opacity: 0, y: 40 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <div className="relative bg-[#1a1a2e] rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
            {/* Animated border */}
            <motion.div
              className="absolute inset-0 opacity-50"
              style={{
                background: 'linear-gradient(90deg, #10b981, #3b82f6, #10b981)',
                backgroundSize: '200% 100%',
                padding: '2px',
                mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                maskComposite: 'exclude',
                WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
                WebkitMaskComposite: 'xor',
              }}
              animate={{
                backgroundPosition: ['0% 0%', '200% 0%'],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                ease: 'linear',
              }}
            />

            {/* Terminal header */}
            <div className="flex items-center gap-2 px-4 py-3 bg-[#16162e] border-b border-white/5">
              <Terminal className="w-4 h-4 text-green-400" />
              <span className="text-sm text-gray-400">terminal</span>
              <div className="ml-auto flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/50" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
                <div className="w-3 h-3 rounded-full bg-green-500/50" />
              </div>
            </div>

            {/* Terminal content */}
            <div className="p-6 font-mono text-sm">
              {/* Command */}
              <div className="flex items-start gap-2 mb-4">
                <span className="text-green-400">$</span>
                <div className="flex-1">
                  <span className="text-gray-300">{command}</span>
                  {command.length < fullCommand.length && (
                    <motion.span
                      animate={{ opacity: [1, 0] }}
                      transition={{ duration: 0.5, repeat: Infinity }}
                      className="inline-block w-2 h-4 bg-green-400 ml-1"
                    />
                  )}
                </div>
              </div>

              {/* Response */}
              {showResponse && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="text-gray-400"
                >
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: 'auto' }}
                    transition={{ duration: 0.8 }}
                    className="overflow-hidden"
                  >
                    <pre className="text-xs leading-relaxed">
{`{
  "data": [`}
{response.data.map((todo, i) => (
  <motion.div
    key={i}
    initial={{ opacity: 0, x: -20 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{ delay: i * 0.2 }}
  >
{`    {
      "id": ${todo.id},
      "title": "${todo.title}",
      "completed": ${todo.completed},
      "userId": ${todo.userId},
      "dueDate": "${todo.dueDate}"
    }${i < response.data.length - 1 ? ',' : ''}`}
  </motion.div>
))}
{`  ],
  "status": `}<span className="text-green-400">200</span>
{`}`}
                    </pre>
                  </motion.div>

                  {/* Metrics */}
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 1 }}
                    className="mt-4 flex items-center gap-6 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-green-400 rounded-full" />
                      <span className="text-green-400">Status: 200 OK</span>
                    </div>
                    <div className="text-gray-500">
                      Time: <span className="text-blue-400">47ms</span>
                    </div>
                    <div className="text-gray-500">
                      Size: <span className="text-purple-400">328 bytes</span>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Info cards */}
        <motion.div
          className="grid md:grid-cols-3 gap-4 mt-8"
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 1.2 }}
        >
          {[
            { label: 'Response Time', value: '< 50ms', color: 'green' },
            { label: 'Uptime', value: '99.9%', color: 'blue' },
            { label: 'Rate Limit', value: '1000/hr', color: 'purple' },
          ].map((stat, i) => (
            <motion.div
              key={i}
              className="p-4 bg-white/5 backdrop-blur-xl rounded-xl border border-white/10"
              whileHover={{ scale: 1.05, borderColor: 'rgba(255, 255, 255, 0.2)' }}
              transition={{ duration: 0.2 }}
            >
              <p className="text-sm text-gray-400 mb-1">{stat.label}</p>
              <p className={`text-2xl font-bold text-${stat.color}-400`}>
                {stat.value}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
