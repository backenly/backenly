import { Logo } from '@/components/Logo'

export function GlobalLoading({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-black">
      <div className="text-center">
        <div className="inline-block animate-pulse mb-4">
          <Logo />
        </div>
        <p className="text-gray-400 text-sm">{message}</p>
      </div>
    </div>
  )
}
