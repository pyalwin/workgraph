const statusColors: Record<string, string> = {
  done: 'bg-accent-green',
  active: 'bg-black',
  stale: 'bg-accent-red',
  open: 'bg-g6',
  in_progress: 'bg-black',
};

export function StatusDot({ status }: { status: string }) {
  return (
    <span className={`inline-block w-[7px] h-[7px] rounded-full ${statusColors[status] || 'bg-g6'}`} />
  );
}
