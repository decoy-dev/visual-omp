import { LoadFailedSilently, lazyView } from "../../registry/lazy";
import { globals } from "../../registry/slots";

// The tracker draws nothing itself; if it does not load, live previews do not start and the window keeps working.
globals.register({ id: "live-preview", component: lazyView(() => import("./Tracker").then(module => module.Tracker), null, LoadFailedSilently) });
