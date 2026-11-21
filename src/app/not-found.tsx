import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-20">
      <p className="mb-6 text-xs uppercase tracking-[0.3em] text-gold">留影 Afterlight</p>
      <h1 className="font-display text-4xl text-text">这一页不存在</h1>
      <p className="mt-6 max-w-xl text-base leading-relaxed text-muted">
        链接可能已失效，或这场影展已被删除。别担心——你本机的其它照片与影展不受影响。
      </p>
      <div className="mt-10 flex flex-wrap gap-4">
        <Link href="/" className="btn btn-primary">
          返回首页
        </Link>
        <Link href="/create" className="btn btn-outline">
          开始策展
        </Link>
      </div>
    </main>
  );
}