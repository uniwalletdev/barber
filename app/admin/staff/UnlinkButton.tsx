"use client";

import ActionButton from "@/app/_components/ActionButton";
import { unlinkAccount } from "@/src/server/staff-actions";

export default function UnlinkButton({
  clerkUserId,
  label,
}: {
  clerkUserId: string;
  label: string;
}) {
  return (
    <ActionButton
      action={unlinkAccount.bind(null, clerkUserId)}
      className="btn-quiet"
      confirm={`Remove this account's access to ${label}'s queue?`}
    >
      Unlink
    </ActionButton>
  );
}
