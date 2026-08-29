import Link from "next/link";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

/**
 * Staff controls, deliberately labelled as such.
 *
 * Customers never sign in — putting a bare "Sign up" above a queue would read
 * as a requirement to register before joining, which is exactly the friction
 * the remote-join flow exists to remove.
 */
export default function StaffBar() {
  return (
    <div className="staffbar">
      <div className="staffbar-inner">
        <Show when="signed-out">
          <span className="staffbar-label">Staff</span>
          <SignInButton mode="modal">
            <button type="button" className="btn-quiet staffbar-btn">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button type="button" className="btn-quiet staffbar-btn">
              Create account
            </button>
          </SignUpButton>
        </Show>

        <Show when="signed-in">
          <Link href="/barber" className="btn-quiet staffbar-btn">
            My queue
          </Link>
          <Link href="/admin" className="btn-quiet staffbar-btn">
            Shop
          </Link>
          <UserButton />
        </Show>
      </div>
    </div>
  );
}
