---
stack: android
---

# Android (Gradle)

## All roles

This is an Android app/library built with Gradle (usually Kotlin, sometimes Java).

- Build with the wrapper: `./gradlew --console=plain -q <task>`; scope to a module when possible (`:app:assembleDebug`, `:feature:foo:testDebugUnitTest`).
- Gradle is slow: never run `clean` unless a build is clearly stale; never run `connectedAndroidTest` (no emulator).
- Dependencies live in the version catalog `gradle/libs.versions.toml` when present; reference them as `libs.xxx`, never hard-code coordinates in module build files.
- Respect the module graph (e.g. `:core:*` must not depend on `:feature:*`). Convention plugins live in `build-logic/` or `buildSrc/`.
- User-facing strings go in `res/values/strings.xml` (plus existing translations folders only if the project keeps them in sync); never hard-code them in Kotlin/Compose/XML.
- Product flavors change task names (`assembleFreeDebug`, `testFreeDebugUnitTest`); check `productFlavors` before choosing a task.

## Scout

Map: `settings.gradle(.kts)` modules, `build-logic/`, version catalog, `AndroidManifest.xml` files, application class.
Identify UI toolkit (Jetpack Compose vs XML views/Fragments), architecture (MVVM/MVI, use cases), DI (Hilt/Koin/Dagger),
navigation (Navigation Compose/Fragments), async (coroutines/Flow vs RxJava), networking (Retrofit/Ktor), persistence (Room/DataStore).
For tests: `src/test` (JVM) vs `src/androidTest` (instrumented), and the frameworks (JUnit4/5, MockK/Mockito, Turbine, Robolectric, coroutines-test, Truth).
Commands: `./gradlew assembleDebug`, `testDebugUnitTest`, `lintDebug`, plus detekt/ktlint/spotless if configured.

## Planner

- Every subtask must keep `assembleDebug` green; add new classes before the code that uses them.
- New screens: name the ViewModel, UI state class, composable/fragment, navigation entry and DI module changes explicitly.
- New dependencies: separate first subtask that edits `libs.versions.toml` + the module `build.gradle.kts`.
- Manifest changes (permissions, activities, providers) get their own step and a manual check.
- Test plan: JVM unit tests for ViewModels, use cases, mappers, repositories (with fakes), not instrumented tests.

## Builder

- Kotlin style: immutable `val`s, `data class` UI state, sealed interfaces for events/results, `StateFlow` exposed as read-only.
- Coroutines: launch in `viewModelScope`/lifecycle-aware scopes; inject dispatchers if the codebase does; never `GlobalScope`, never block the main thread.
- Compose: hoist state, pass lambdas down, keep previews compiling if the file has them, use `stringResource(R.string.x)`.
- Hilt: annotate new ViewModels with `@HiltViewModel` + `@Inject constructor`; bind new interfaces in the existing module.
- Verify with `./gradlew --console=plain -q :<module>:assembleDebug 2>&1 | tail -n 60`; read `e: file:line` lines first.

## Tester

- JVM tests in `<module>/src/test/...` mirroring the production package.
- Coroutines: `runTest` + `StandardTestDispatcher`/`MainDispatcherRule` as the project does; Flows with Turbine if present.
- Prefer fakes over mocks if the project already has fakes.
- Run: `./gradlew --console=plain -q :<module>:testDebugUnitTest --tests '*FooTest*' 2>&1 | tail -n 80`.
- Never write `androidTest` tests (no emulator).

## Reviewer

Android-specific blockers:
- Lifecycle: collecting flows outside `repeatOnLifecycle`/`collectAsStateWithLifecycle`, leaking `Context`/`Activity`/`View` into ViewModels or singletons.
- Main-thread I/O, missing dispatcher switches, unscoped coroutines.
- State lost on configuration change or process death where it matters (`SavedStateHandle`).
- Hard-coded user-facing strings, missing `contentDescription` on actionable icons, missing translations if the project keeps them complete.
- Manifest/permission changes without runtime-permission handling; exported components without need.
- R8/ProGuard: reflection/serialization on new classes without keep rules (if the project minifies).
