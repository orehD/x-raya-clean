*отдавать только во внутренние ЛЛМ с критичными данными

---

# 📘 **Руководство: Как строить поисковые запросы в системе найма**
---

## 🔧 1. Общие правила

### ✅ Структура запроса
- Весь запрос — **объект фильтра**
- **Не нужна** обёртка `"filter": { ... }`
- **Не нужна** обёртка `"query"` или `"bool"`
- Пример:
  ```json
  {
    "name": {
      "text_match": {
        "value": "Максим"
      }
    }
  }
  ```

---

## 📐 2. Логические операторы

Используются на **том же уровне**, что и поля.

### `$and` — все условия должны выполняться
```json
{
  "$and": [
    { "поле1": { ... } },
    { "поле2": { ... } }
  ]
}
```

### `$or` — хотя бы одно условие
```json
{
  "$or": [
    { "поле1": { ... } },
    { "поле2": { ... } }
  ]
}
```

### `$not` — условие НЕ выполняется
```json
{
  "$not": {
    "поле": { ... }
  }
}
```

> ❗ `$not` — **всегда объект**, не массив

---

## 📂 3. Фильтрация по вложенным массивам (`nested`)

Когда поле — **массив объектов**, используй `nested_any`.

### Формат:
```json
{
  "имяМассива": {
    "nested_any": {
      "filter": {
        "поле": { "оператор": { ... } }
      }
    }
  }
}
```

### Пример:
```json
{
  "hiringProcesses": {
    "nested_any": {
      "filter": {
        "closingReasonsIds": {
          "int_list_contains_any_of": {
            "values": [1, 2]
          }
        }
      }
    }
  }
}
```

> ⚠️ `filter` **обязателен** внутри `nested_any`

---

## 🔤 4. Операторы для текстовых полей

### `text_match` — полнотекстовый поиск
- Для полей типа `text`
- Пример:
  ```json
  "name": {
    "text_match": {
      "value": "Максим"
    }
  }
  ```

### `text_list_matches_any_of` — хотя бы один тег совпадает
- Для полей типа `text_list`
- Пример:
  ```json
  "tags": {
    "text_list_matches_any_of": {
      "values": ["стажёр"]
    }
  }
  ```

---

## 🔢 5. Операторы для чисел

### `int_eq` — равно
```json
"plainEventState": {
  "int_eq": {
    "value": 19
  }
}
```

### `int_one_of` — одно из списка
```json
"plainEventState": {
  "int_one_of": {
    "values": [19, 20, 21]
  }
}
```

### `int_gt`, `int_lt` — больше/меньше
```json
"birthYear": {
  "int_gt": {
    "value": 1990
  }
}
```

---

## 📦 6. Операторы для списков чисел

### `int_list_contains_any_of` — содержит хотя бы одно из
- Для полей типа `int_list`
- Пример:
  ```json
  "closingReasonsIds": {
    "int_list_contains_any_of": {
      "values": [1, 2]
    }
  }
  ```

> ❌ Нельзя использовать `int_one_of` для `int_list`

---

## 🧩 7. Вложенные вложенные объекты

Когда есть массив объектов, внутри которых — ещё массив объектов:

### Пример: `hiringProcesses.events`
```json
{
  "hiringProcesses": {
    "nested_any": {
      "filter": {
        "events": {
          "nested_any": {
            "filter": {
              "plainEventState": {
                "int_eq": {
                  "value": 19
                }
              }
            }
          }
        }
      }
    }
  }
}
```

> ❗ `filter` нужен **на каждом уровне**

---

## 🚫 8. Что НЕ работает

| Что пробовали | Почему не работает |
|---------------|--------------------|
| `"filter": { ... }` на верхнем уровне | Не поддерживается |
| `int_one_of` для `int_list` | Нужно `int_list_contains_any_of` |
| `string_eq` для `text_list` | Нужно `text_list_matches_any_of` |
| `date`-поля без `Op_date_*` в схеме | Не проиндексированы |
| `nested_any` без `filter` | Ошибка валидации (в `hiringProcesses`, `events`) |

---

## 🧠 9. Ключевые поля и их типы

| Поле | Тип | Оператор | Примечание |
|------|-----|----------|-----------|
| `name`, `location` | `text` | `text_match` | |
| `tags` | `text_list` | `text_list_matches_any_of` | |
| `specializationIds` | `string_list` | `string_one_of` | |
| `employeeStatus.status` | `string` (enum) | `string_eq` | Значения: `"Employed"`, `"Dismissed"` и др. |
| `employeeDismissalReasonIsNegative` | `bool` | `bool_eq` | `true` / `false` |
| `hiringProcesses` | `nested[]` | `nested_any` + `filter` | |
| `hiringProcesses.closingReasonsIds` | `int_list` | `int_list_contains_any_of` | |
| `hiringProcesses.events` | `nested[]` | `nested_any` + `filter` | |
| `hiringProcesses.events.plainEventState` | `int` | `int_eq`, `int_one_of` | Коды событий |

---

## 🧩 10. Примеры статусов `plainEventState` (оффер)

| Код | Событие |
|-----|--------|
| 19 | OfferStarted |
| 20 | OfferPassed |
| 21 | OfferNotPassed |
| 39 | OfferScheduled |
| 44 | OfferCanceled |
| 73 | OfferOnApproval |
| 74 | OfferWaitingSendToCandidate |
| 75 | OfferRejectByApprovers |
| 166 | OfferInformationCollection |
| 167 | OfferWaitingImprovedOfferDecision |
| 232 | OfferWfeSuspended |

---

## ✅ 11. Пример: Все, кто дошёл до оффера, не трудоустроен, не "читер", нет негатива

```json
{
  "$and": [
    {
      "$not": {
        "tags": {
          "text_list_matches_any_of": {
            "values": ["читер"]
          }
        }
      }
    },
    {
      "$not": {
        "employeeStatus": {
          "string_eq": {
            "value": "Employed"
          }
        }
      }
    },
    {
      "$not": {
        "employeeDismissalReasonIsNegative": {
          "bool_eq": {
            "value": true
          }
        }
      }
    },
    {
      "hiringProcesses": {
        "nested_any": {
          "filter": {
            "events": {
              "nested_any": {
                "filter": {
                  "plainEventState": {
                    "int_one_of": {
                      "values": [
                        19, 20, 21, 39, 44, 73, 74, 75, 166, 167, 232
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  ]
}

---

{
  "mainId": "",
  "name": "",
  "surname": "",
  "patronymic": "",
  "birthDay": 1,
  "birthMonth": 1,
  "birthYear": 1990,
  "birthdate": "1990-01-01",
  "gender": 1,
  "locationId": "",
  "location": "",
  "citizenshipId": 1,
  "citizenship": "",
  "contacts": [
    {
      "type": 1,
      "value": ""
    }
  ],
  "nonStructuredContacts": [""],
  "tagsIds": [""],
  "tags": [""],
  "employeeStatus": {
    "status": 1,
    "peopleHubDismissalGeneralReasonId": 1,
    "peopleHubDismissalGeneralReason": "",
    "peopleHubDismissalGeneralReasonIsNegative": false,
    "peopleHubDismissalDate": ""
  },
  "speechEvaluation": {
    "result": 1,
    "ratedByInitiatorMasterId": 1000,
    "ratedAtUtc": ""
  },
  "educations": [
    {
      "faculty": "",
      "organizationName": "",
      "specialization": "",
      "educationLevel": 1,
      "graduationYear": 2010
    }
  ],
  "workExperience": [
    {
      "title": "",
      "organizationName": "",
      "cityId": "",
      "city": "",
      "dateStart": "2024-03-15",
      "dateEnd": "2025-04-02",
      "organizationUrl": "",
      "description": ""
    }
  ],
  "uniqueIdentifiers": [
    {
      "code": "",
      "value": ""
    }
  ],
  "facts": [
    {
      "id": "d35a23ca-f93d-4d18-b0a3-d2cc38d8422c",
      "sourceCode": "",
      "sourceId": "",
      "name": "",
      "surname": "",
      "patronymic": "",
      "birthDay": 1,
      "birthMonth": 1,
      "birthYear": 1990,
      "birthdate": "1990-01-01",
      "gender": 1,
      "locationId": "",
      "location": "",
      "citizenshipId": 1,
      "citizenship": "",
      "contacts": [
        {
          "type": 1,
          "value": ""
        }
      ],
      "nonStructuredContacts": [""],
      "tagsIds": [""],
      "tags": [""],
      "employeeStatus": {
        "status": 1,
        "peopleHubDismissalGeneralReasonId": 1,
        "peopleHubDismissalGeneralReason": "",
        "peopleHubDismissalGeneralReasonIsNegative": false,
        "peopleHubDismissalDate": ""
      },
      "speechEvaluation": {
        "result": 1,
        "ratedByInitiatorMasterId": 1000,
        "ratedAtUtc": ""
      },
      "educations": [
        {
          "faculty": "",
          "organizationName": "",
          "specialization": "",
          "educationLevel": 1,
          "graduationYear": 2010
        }
      ],
      "workExperience": [
        {
          "title": "",
          "organizationName": "",
          "cityId": "",
          "city": "",
          "dateStart": "2024-05-09",
          "dateEnd": "2025-05-01",
          "organizationUrl": "",
          "description": ""
        }
      ],
      "uniqueIdentifiers": [
        {
          "code": "",
          "value": ""
        }
      ]
    }
  ],
  "meetups": [
    {
      "meetup": {
        "id": "",
        "title": "",
        "format": "",
        "cityId": "",
        "city": "",
        "startUtc": "",
        "endUtc": ""
      },
      "application": {
        "name": "",
        "surname": "",
        "city": "",
        "occupation": 1,
        "company": "",
        "experience": 1,
        "specializationId": "",
        "specialization": "",
        "programmingLanguages": "",
        "comment": "",
        "marketingCommunicationConsentGivenAt": "",
        "personalDataProcessingConsentGivenAt": "",
        "contacts": [
          {
            "type": 1,
            "value": ""
          }
        ]
      }
    }
  ],
  "internships": [
    {
      "selection": {
        "id": "",
        "title": "",
        "program": 1,
        "streamId": "",
        "stream": "",
        "specializationsIds": [""],
        "specializations": [""],
        "examsStartDate": "",
        "examsFinishDate": ""
      },
      "application": {
        "id": "",
        "name": "",
        "surname": "",
        "patronymic": "",
        "birthDay": "2010-12-29",
        "preferredLearningCity": "",
        "school": {
          "cityId": "",
          "city": "",
          "schoolId": "",
          "school": "",
          "graduationYear": 2005
        },
        "university": {
          "cityId": "",
          "city": "",
          "universityId": "",
          "university": "",
          "facultyId": "",
          "faculty": "",
          "chairId": "",
          "chair": "",
          "graduationYear": 2010
        },
        "occupation": {
          "companyName": "",
          "position": ""
        },
        "about": "",
        "bankClient": true,
        "marketingCommunicationConsentGivenAt": "",
        "personalDataProcessingConsentGivenAt": "",
        "eduAccountId": 50000,
        "contacts": [
          {
            "type": 1,
            "value": ""
          }
        ]
      }
    }
  ],
  "resumes": [
    {
      "name": "",
      "surname": "",
      "patronymic": "",
      "birthDay": 1,
      "birthMonth": 1,
      "birthYear": 1990,
      "birthdate": "1990-01-01",
      "gender": 1,
      "citizenshipId": 1,
      "citizenship": "",
      "locationId": "",
      "location": "",
      "declaredSpecialization": "",
      "about": "",
      "declaredSkills": [""],
      "inferredSkills": [""],
      "hobbies": [""],
      "languages": [
        {
          "language": "",
          "level": ""
        }
      ],
      "preferredSchedules": [""],
      "additionalEducation": [
        {
          "name": "",
          "type": "",
          "year": 2012
        }
      ],
      "higherEducation": [
        {
          "university": "",
          "faculty": "",
          "major": "",
          "degree": "",
          "startYear": 2015,
          "endYear": 2010
        }
      ],
      "workExperience": {
        "totalMonths": 36,
        "totalYears": 3,
        "records": [
          {
            "company": "",
            "locationId": "",
            "location": "",
            "position": "",
            "description": "",
            "startDate": "2020-12-24",
            "endDate": "2023-08-31",
            "isCurrent": false,
            "isIt": true
          }
        ]
      },
      "preferredLocations": [
        {
          "locationId": "",
          "location": ""
        }
      ],
      "contacts": [
        {
          "type": 1,
          "value": ""
        }
      ],
      "nonStructuredContacts": [""],
      "createdUtc": ""
    }
  ],
  "changedUtc": "",
  "files": [""],
  "recruitersIds": [""],
  "recruitersMasterIds": [1000],
  "accessMasterIds": [10000],
  "offices": [""],
  "specializations": [""],
  "levels": [""],
  "interviewTypes": [""],
  "hiringProcesses": [
    {
      "vacancyId": "",
      "lastEventState": 46,
      "events": [
        {
          "createdUtc": "",
          "plainEventState": 16
        }
      ]
    }
  ]
}

---

Еще ЛЛМ нужна JSON Schema и поля, они есть на странице материалы. Можно не копировать все, а отдавать частями. Если нужен запрос по специализациям, отдать все, что касается только специализации