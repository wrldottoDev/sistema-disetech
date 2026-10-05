import { redirect } from "next/navigation";
import { getPrincipal } from "@/lib/authorization";
export default async function Home() { redirect((await getPrincipal()) ? "/panel" : "/login"); }
