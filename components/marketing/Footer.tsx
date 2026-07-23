'use client'

import Link from 'next/link'
import { Github, Twitter } from 'lucide-react'

export function Footer() {
  return (
    <footer className="border-t border-dark-border py-12 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          <div>
            <div className="flex items-center space-x-2 mb-4">
              <div className="w-8 h-8 bg-primary-500 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-lg">B</span>
              </div>
              <span className="text-xl font-semibold text-white">Backenly</span>
            </div>
            <p className="text-gray-400 text-sm">
              The AI Backend OS for Developers
            </p>
          </div>
          
          <div>
            <h4 className="text-white font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/features" className="hover:text-white transition-colors">Features</Link></li>
              <li><Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="text-white font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/blog" className="hover:text-white transition-colors">Blog</Link></li>
              <li><Link href="/support" className="hover:text-white transition-colors">Support</Link></li>
            </ul>
          </div>
          
          <div>
            <h4 className="text-white font-semibold mb-4">Legal</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/terms" className="hover:text-white transition-colors">Terms</Link></li>
              <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link></li>
            </ul>
          </div>
        </div>
        
        <div className="flex items-center justify-between pt-8 border-t border-dark-border">
          <p className="text-gray-500 text-sm">© 2024 Backenly. All rights reserved.</p>
          <div className="flex items-center space-x-4">
            <Link href="https://github.com" className="text-gray-400 hover:text-white transition-colors">
              <Github className="w-5 h-5" />
            </Link>
            <Link href="https://twitter.com" className="text-gray-400 hover:text-white transition-colors">
              <Twitter className="w-5 h-5" />
            </Link>
          </div>
        </div>
      </div>
    </footer>
  )
}

