import { Twitter } from 'lucide-react';
import Link from 'next/link';

export default function Footer() {
  return (
    <footer className="border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex flex-col items-center justify-center gap-2 px-4 py-6 text-center sm:flex-row sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Created by{' '}
          <Link
            href="https://twitter.com/tusharlog1"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary hover:underline underline-offset-4"
          >
            Tushar Khatwani
          </Link>
        </p>
        <Link
          href="https://twitter.com/tusharlog1"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          <Twitter className="h-4 w-4" />
          @tusharlog1
        </Link>
      </div>
    </footer>
  );
}
