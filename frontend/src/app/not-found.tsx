import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="page">
      <div className="empty" style={{ minHeight: '60vh' }}>
        <h1>404</h1>
        <p>ไม่พบหน้านี้ · Page not found</p>
        <Link className="btn" href="/">
          กลับไปที่แผนที่ · Back to the map
        </Link>
      </div>
    </div>
  );
}
