/**
 * Generate a meaningful project name from a user prompt
 * Instead of just taking first 3 words, intelligently extract domain keywords
 * Example: "I want to build a shoe selling app" -> "shoemart"
 */
export function generateMeaningfulProjectName(promptText: string): string {
  if (!promptText.trim()) return 'my-project'
  
  const text = promptText.toLowerCase()
  
  // Check for specific domain patterns first
  if (text.includes('ecommerce') || text.includes('e-commerce') || text.includes('shopping')) {
    if (text.includes('shoe') || text.includes('boot') || text.includes('sneaker') || text.includes('footwear')) {
      return 'shoemart'
    }
    if (text.includes('book') || text.includes('novel') || text.includes('reading')) {
      return 'bookstore'
    }
    if (text.includes('food') || text.includes('restaurant') || text.includes('cafe') || text.includes('pizza') || text.includes('burger')) {
      return 'foodhub'
    }
    if (text.includes('cloth') || text.includes('fashion') || text.includes('apparel') || text.includes('dress') || text.includes('shirt')) {
      return 'fashionhub'
    }
    if (text.includes('grocery') || text.includes('supermarket') || text.includes('mart')) {
      return 'grocerymart'
    }
    if (text.includes('electronic') || text.includes('gadget') || text.includes('phone') || text.includes('laptop')) {
      return 'techstore'
    }
    return 'marketplace'
  }
  
  // Content & Social
  if (text.includes('social') || text.includes('network') || text.includes('social media')) {
    return 'socialize'
  }
  if (text.includes('blog') || text.includes('article') || text.includes('writing')) {
    return 'blog'
  }
  if (text.includes('video') || text.includes('streaming') || text.includes('youtube')) {
    return 'videohub'
  }
  if (text.includes('music') || text.includes('song') || text.includes('playlist') || text.includes('audio') || text.includes('podcast')) {
    return 'soundwave'
  }
  if (text.includes('photo') || text.includes('image') || text.includes('gallery')) {
    return 'gallery'
  }
  
  // Travel & Booking
  if (text.includes('booking') || text.includes('appointment') || text.includes('reserve') || text.includes('schedule')) {
    return 'bookly'
  }
  if (text.includes('hotel') || text.includes('accommodation') || text.includes('resort') || text.includes('lodge')) {
    return 'stayxyz'
  }
  if (text.includes('flight') || text.includes('airline') || text.includes('travel') || text.includes('trip')) {
    return 'flighty'
  }
  if (text.includes('ride') || text.includes('taxi') || text.includes('uber') || text.includes('car rental') || text.includes('transport')) {
    return 'rideshare'
  }
  
  // Delivery & Logistics
  if (text.includes('delivery') || text.includes('logistics') || text.includes('shipping')) {
    return 'deliveroo'
  }
  
  // Health & Fitness
  if (text.includes('health') || text.includes('medical') || text.includes('doctor') || text.includes('clinic') || text.includes('hospital')) {
    return 'medcare'
  }
  if (text.includes('fitness') || text.includes('gym') || text.includes('workout') || text.includes('exercise') || text.includes('trainer')) {
    return 'fitpro'
  }
  
  // Education & Learning
  if (text.includes('learning') || text.includes('education') || text.includes('course') || text.includes('training') || text.includes('school')) {
    return 'academy'
  }
  if (text.includes('tutorial') || text.includes('teach') || text.includes('lesson') || text.includes('class')) {
    return 'learnhub'
  }
  
  // Finance
  if (text.includes('bank') || text.includes('finance') || text.includes('payment') || text.includes('wallet') || text.includes('crypto') || text.includes('blockchain')) {
    return 'fintech'
  }
  if (text.includes('invoice') || text.includes('bill') || text.includes('accounting') || text.includes('tax')) {
    return 'billwise'
  }
  
  // Productivity & Business
  if (text.includes('project') || text.includes('task') || text.includes('todo') || text.includes('productivity') || text.includes('management')) {
    return 'taskflow'
  }
  if (text.includes('crm') || text.includes('customer') || text.includes('sales') || text.includes('contact')) {
    return 'salesforce'
  }
  if (text.includes('collaboration') || text.includes('team') || text.includes('workspace')) {
    return 'workspace'
  }
  
  // Fallback: Extract meaningful words (filter out common stop words)
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'from', 'as', 'is', 'be', 'have', 'do', 'will', 'would', 'could', 'should', 'may', 'can',
    'my', 'your', 'his', 'her', 'its', 'this', 'that', 'i', 'you', 'we', 'they',
    'api', 'rest', 'app', 'application', 'build', 'create', 'make', 'want', 'need',
    'backend', 'system', 'platform', 'service', 'server', 'database', 'project',
    'that', 'using', 'with', 'user', 'users', 'like', 'likes', 'where', 'when', 'how',
  ])
  
  const words = text
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.has(word))
    .slice(0, 2)
  
  if (words.length > 0) {
    return words.join('')
  }
  
  return 'project'
}
