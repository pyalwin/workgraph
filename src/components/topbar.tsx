'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Layers, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navItems = [
  { label: 'Overview', href: '/' },
  { label: 'Goals', href: '/goals' },
  { label: 'Projects', href: '/projects' },
  { label: 'Knowledge', href: '/knowledge' },
  { label: 'Metrics', href: '/metrics' },
];

export function Topbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 flex items-center justify-between px-10 h-[52px] bg-white/85 backdrop-blur-xl border-b border-black/[0.07]">
      <div className="flex items-center gap-7">
        <Link href="/" className="flex items-center gap-2 no-underline">
          <div className="w-[22px] h-[22px] rounded-[6px] bg-black grid place-items-center">
            <Layers className="w-[11px] h-[11px] text-white" strokeWidth={2.5} />
          </div>
          <span className="text-[0.87rem] font-semibold text-black tracking-tight">WorkGraph</span>
        </Link>
        <nav className="flex gap-px">
          {navItems.map((item) => {
            const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "px-[11px] py-[5px] rounded-[6px] text-[0.8rem] no-underline transition-all",
                  isActive
                    ? "text-black bg-black/5 font-medium"
                    : "text-[#999] hover:text-[#333] hover:bg-black/[0.03]"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="gap-2 text-[0.78rem] text-[#999] h-[30px]">
          <Search className="w-[13px] h-[13px]" />
          Search
          <kbd className="text-[0.67rem] text-[#bbb] px-1 rounded border border-black/[0.07] bg-[#f5f5f5]">⌘K</kbd>
        </Button>
        <div className="flex items-center gap-[5px] h-[26px] px-[9px] rounded-full bg-[#f5f5f5] text-[0.68rem] font-medium text-[#555]">
          <span className="w-[5px] h-[5px] rounded-full bg-black animate-pulse" />
          Synced 12m ago
        </div>
      </div>
    </header>
  );
}
