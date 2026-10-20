/** Home feature: the screen the app opens on and the title bar's Home button shows (DESIGN §4.24). */
import { screens } from "@/registry/slots";
import { HomeScreen } from "./HomeScreen";

screens.register({ id: "home", component: HomeScreen });
