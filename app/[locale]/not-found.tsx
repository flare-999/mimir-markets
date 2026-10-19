import EmptyState from "@/components/EmptyState";
import PageFrame from "@/components/PageFrame";

// Copy kept minimal and in English directly without adding unvetted translation keys.
export default function NotFound() {
  return (
    <PageFrame>
      <div className="flex min-h-[60vh] items-center justify-center py-12">
        <EmptyState
          title="Page not found"
          description="The page you are looking for does not exist or has been moved."
          actionLabel="Back to Explorer"
          actionHref="/explorer"
        />
      </div>
    </PageFrame>
  );
}
