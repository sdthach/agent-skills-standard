# Security Scan Signals (SAST)

Use these commands to perform a breadth scan of the codebase. Run them against `$SRC` — detect it from the project's manifest file:

| Manifest                         | Framework     | `$SRC`                | `$EXT`    |
| -------------------------------- | ------------- | --------------------- | --------- |
| `pubspec.yaml`                   | Flutter       | `lib/`                | `dart`    |
| `nest-cli.json`                  | NestJS        | `src/`                | `ts`      |
| `next` in deps                   | Next.js       | `src/`                | `ts,tsx`  |
| `react-native` in deps           | React Native  | `src/` or `app/`      | `ts,tsx`  |
| `react` in deps                  | React         | `src/`                | `ts,tsx`  |
| `angular.json`                   | Angular       | `src/app/`            | `ts`      |
| `go.mod`                         | Golang        | `.`                   | `go`      |
| `pom.xml` + `spring-boot` dep    | Spring Boot   | `src/main/java`       | `java`    |
| `build.gradle.kts` + android app | Android       | `app/src/main`        | `kt,java` |
| `Podfile` or `.xcodeproj`        | iOS           | `Sources/` or app dir | `swift`   |
| `artisan` file                   | Laravel       | `app/`                | `php`     |
| `composer.json` (no artisan)     | PHP           | `src/`                | `php`     |
| `package.json`                   | TypeScript/JS | `src/`                | `ts,js`   |

> [!IMPORTANT]
> **Record `$SRC` and `$EXT` before scanning.** Running against a wrong or non-existent directory returns empty results that read as a clean scan.

## 1. Hardcoded Secrets

```bash
grep -riE "(password|apiKey|api_key|secret|private_key|token)\s*=\s*['\"][^'\"]{6,}" \
  $SRC --exclude-dir={node_modules,dist,build,.git} -l
```

## 2. PII / Sensitive Data in Logs

- **React/TS/JS**: `grep -rE "console\.(log|error|warn)" $SRC --include="*.ts" --include="*.js" | grep -iE "password|token|secret|private"`
- **Go**: `grep -rE "log\.(Print|Printf|Println|Fatal)" $SRC --include="*.go" | grep -iE "password|token|secret"`
- **Flutter**: `grep -rE "print\(|debugPrint\(" $SRC --include="*.dart" | grep -iE "password|token|secret"`
- **Java/Kotlin**: `grep -rE "log(ger)?\.(info|debug|warn|error)|Log\.[dev]" $SRC --include="*.java" --include="*.kt" | grep -iE "password|token|secret"`

## 3. Injection Surfaces

```bash
grep -rE "\+.*SELECT|\+.*INSERT|\+.*UPDATE|\+.*DELETE|query\(.*\+|fmt\.Sprintf.*SELECT|exec\(.*\+" \
  $SRC --include="*.ts" --include="*.js" --include="*.go" \
       --include="*.java" --include="*.kt" --include="*.dart" \
       --include="*.php" --include="*.swift"
```

## 4. Auth Coverage (Unguarded Routes)

- **NestJS**: `total=$(grep -rE "@(Get|Post|Put|Delete|Patch)\(" $SRC | wc -l); guarded=$(grep -rE "@(UseGuards|Auth)\(" $SRC | wc -l)`
- **Spring**: `total=$(grep -rE "@(GetMapping|PostMapping|PutMapping|DeleteMapping|RequestMapping)" $SRC | wc -l); guarded=$(grep -rE "@(PreAuthorize|Secured|RolesAllowed)" $SRC | wc -l)`
- **Laravel**: `total=$(grep -rE "Route::(get|post|put|delete|patch)" routes/ | wc -l); guarded=$(grep -rE "middleware\(|->middleware" routes/ | wc -l)`

## 5. Reachable RCE / SSRF / Path Traversal

| Risk                   | What to scan for                                                 |
| :--------------------- | :--------------------------------------------------------------- |
| **RCE — dynamic eval** | `eval(`, `new Function(`, `shell_exec(`, `exec(`                 |
| **SSRF**               | `axios.get(`, `fetch(`, `http.Get(` where URL is dynamic         |
| **Path Traversal**     | File I/O where path is from user input without `path.join/Clean` |

## Scoring Impact

- 🔴 **Critical**: Hardcoded secrets, RCE surface, Unguarded routes > 20%
- 🟠 **High**: SSRF, Raw SQL Concatenation, Path Traversal
- 🟡 **Medium**: N+1 query patterns, High-severity CVEs

> [!IMPORTANT]
> Any 🔴 Critical finding **caps the Security score at 40/100**.
