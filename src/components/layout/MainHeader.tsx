
import Link from 'next/link';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Rss, LayoutGrid } from 'lucide-react'; // Using Rss as a generic logo icon

export default function MainHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center">
        <Link href="/" className="flex items-center space-x-2 mr-6">
          <Rss className="h-6 w-6 text-primary" />
          <span className="font-headline text-xl font-bold text-primary">SipView</span>
        </Link>
        
        <nav className="flex items-center space-x-4 text-sm font-medium">
          <Link href="/" className="text-muted-foreground transition-colors hover:text-primary">
            All SIPs
          </Link>
          <Link href="/topics" className="text-muted-foreground transition-colors hover:text-primary flex items-center gap-1">
            <LayoutGrid size={16} /> Topics
          </Link>
        </nav>

        <div className="flex flex-1 items-center justify-end space-x-4">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
