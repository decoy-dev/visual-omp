import { lazyView } from "../../registry/lazy";
import { globals } from "../../registry/slots";

globals.register({ id: "live-preview", component: lazyView(() => import("./Tracker").then(module => module.Tracker)) });
